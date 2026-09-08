"""IDP-completion-event → Notice mapper.

A document is EVIDENCE on the actual side of the reconciliation, so it maps to a Notice and never to
a ReconItem: an item write is what creates a case, and an extracted document must not create one
-- an extracted document is evidence ABOUT a reconciliation item, never the thing that creates one.
Nothing in this module imports ReconItem, and that is deliberate — restoring such
an import would restore the coupling.

The real IDP completion/tracking record is **PascalCase** (verified against a live run):

    { "ObjectKey": "Notice.pdf",
      "PageCount": 3,
      "WorkflowStatus": "SUCCEEDED",
      "ConfidenceAlertCount": 0,
      "Sections": [ { "Id": "1", "Class": "LoanRateSettingNotice",
                      "PageIds": [1], "OutputJSONUri": "s3://<bucket>/Notice.pdf/sections/1/result.json" }, ... ],
      "Pages":    [ { "Id": 1, "Class": "...", "ImageUri": "s3://<bucket>/Notice.pdf/pages/1/image.jpg" }, ... ] }

The event carries only S3 *pointers*, not the extracted field values. So at ingest we read the
section result.json files from IDP output S3 (via an injected IdpOutputReader) and EMBED the
classification + extracted field values + page-image locations into the ReconItem — the detail
screen renders them directly, with no on-demand IDP call.

Two key styles are accepted throughout: the PascalCase shape above, which is what IDP emits, and a
snake_case equivalent, which is what the unit fixtures are written in.
"""

import logging
from decimal import Decimal, InvalidOperation
from typing import Optional

from backend.recon_core.notice_derive import (
    PARSE_METHOD_IDP,
    SOURCE_SYSTEM_OTHER,
    derive_amount_type,
)
from backend.recon_core.notices import Notice

logger = logging.getLogger(__name__)


def _decimalize(obj):
    """Recursively convert floats → Decimal so nested IDP data is DynamoDB-safe (boto3 rejects
    Python floats). Walks dicts/lists in place; leaves existing Decimals untouched (the IDP
    output reader already decimalizes its result, so we must not choke on Decimals here).
    """
    if isinstance(obj, float):
        return Decimal(str(obj))  # via str() to avoid binary-float imprecision
    if isinstance(obj, dict):
        return {k: _decimalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decimalize(v) for v in obj]
    return obj


def split_s3_uri(uri: str) -> tuple[str, str]:
    """Split an ``s3://bucket/key`` URI into (bucket, key). Returns ('','') if not an s3 URI.

    Public because ``idp_output.IdpOutputReader.resolve_document`` splits the compressed-output
    pointer with it. It lives here rather than there because this module has no boto3 dependency.

    :param uri: the URI to split.
    :returns: ``(bucket, key)``, or ``("", "")`` when ``uri`` is not an ``s3://`` URI.
    """
    if not uri.startswith("s3://"):
        return "", ""
    rest = uri[len("s3://") :]
    bucket, _, key = rest.partition("/")
    return bucket, key


def _derive_output_location(document: dict) -> tuple[str, str, str]:
    """Determine (object_key, output_bucket, output_prefix) from the completion event.

    Prefers a Section/Page ``OutputJSONUri``/``ImageUri`` (authoritative bucket + doc prefix);
    falls back to explicit ``output_bucket`` + ``ObjectKey``. object_key is the IDP document id.
    """
    object_key = document.get("ObjectKey") or document.get("id") or document.get("document_id")
    # Try to pull the bucket + document prefix straight from a section/page URI.
    sample_uri = ""
    for sec in document.get("Sections", []) or []:
        if sec.get("OutputJSONUri"):
            sample_uri = sec["OutputJSONUri"]
            break
    if not sample_uri:
        for pg in document.get("Pages", []) or []:
            if pg.get("ImageUri"):
                sample_uri = pg["ImageUri"]
                break
    if sample_uri:
        bucket, key = split_s3_uri(sample_uri)
        # key looks like "<ObjectKey>/sections/1/result.json" -> prefix is "<ObjectKey>"
        prefix = key.split("/sections/")[0].split("/pages/")[0]
        return object_key, bucket, prefix
    # Fallback: explicit fields, which is also how the snake_case fixtures carry them.
    bucket = document.get("output_bucket", "")
    prefix = document.get("input_key", "") or (object_key or "")
    return object_key, bucket, prefix


def _read_sections(
    document: dict,
    *,
    output_reader: Optional[object],
    out_bucket: str,
    out_prefix: str,
) -> tuple[list[dict], list[dict], Optional[int]]:
    """Resolve a document's sections, page images and page count.

    Shared by both mappers. Prefers the extracted field VALUES read from IDP output S3; falls back
    to the high-level per-section data the completion event itself carries, so a transient IDP-S3
    failure degrades the detail rather than dropping the document.

    :param document: the IDP completion/tracking record (PascalCase; snake_case tolerated).
    :param output_reader: an IdpOutputReader (or compatible), or None to use event data only.
    :param out_bucket: IDP output bucket resolved by :func:`_derive_output_location`.
    :param out_prefix: IDP output prefix (the document id) for that bucket.
    :returns: ``(sections, pages, page_count)`` — sections always in the normalised shape
        ``{section_id, classification, fields, output_uri, page_indices}``; page_count is None when
        neither the event nor the read could supply one.
    """
    # High-level section list from the event itself (classification + result URI per section).
    event_sections = document.get("Sections") or document.get("sections") or []

    enriched_sections: list[dict] = []
    pages: list[dict] = []
    page_count = document.get("PageCount")
    if output_reader is not None and out_bucket and out_prefix:
        try:
            read = output_reader.read(bucket=out_bucket, prefix=out_prefix)
            enriched_sections = read.get("sections", [])
            pages = read.get("pages", [])
            if page_count is None:
                page_count = len(pages)
        except Exception as exc:  # noqa: BLE001 - degrade gracefully, never drop the document
            logger.warning("IDP output read failed for s3://%s/%s: %s", out_bucket, out_prefix, exc)

    # If enrichment wasn't available, fall back to whatever the event carried per section.
    if not enriched_sections:
        for s in event_sections:
            # A section that is a bare string is IDP's COMPRESSED stand-in, whose `sections` is a
            # list of id strings rather than records — see `IdpOutputReader.resolve_document`. If one
            # reaches here the pointer was never followed, so say that: the alternative is
            # `AttributeError: 'str' object has no attribute 'get'` three frames deep, which reads
            # like a mapper bug rather than an unresolved event (cost us a live debug on 2026-09-02).
            if not isinstance(s, dict):
                raise ValueError(
                    f"IDP section {s!r} is not a record — this looks like an unresolved compressed "
                    "event; resolve_document() must run before the mapper"
                )
            sid = str(s.get("Id") or s.get("section_id") or "")
            cls = s.get("Class") or s.get("classification")
            uri = s.get("OutputJSONUri") or s.get("extraction_result_uri") or ""
            enriched_sections.append(
                {
                    "section_id": sid,
                    "classification": cls,
                    "fields": s.get("attributes", {}),
                    "output_uri": uri,
                    "page_indices": [
                        int(p.get("N", p)) if isinstance(p, dict) else p
                        for p in (s.get("PageIds") or [])
                    ],
                }
            )

    return enriched_sections, pages, page_count


def _opt(fields: dict, key: str) -> str | None:
    """Read an extracted field, preserving the absent/blank distinction.

    :param fields: the section's extracted field values.
    :param key: the field name.
    :returns: the string value, ``""`` when extracted but blank, or None when this document's class
        never extracted it at all.
    """
    if key not in fields:
        return None
    return str(fields[key])


def _opt_decimal(fields: dict, key: str) -> Decimal | None:
    """Read an extracted numeric field as a Decimal, preserving absence.

    Decimal rather than float because boto3's DynamoDB resource rejects floats outright.

    :param fields: the section's extracted field values.
    :param key: the field name.
    :returns: the Decimal value, or None when absent or blank.
    :raises ValueError: when the field is present and non-blank but will not parse as a number —
        a silently dropped amount would make an unmatchable notice look merely unmatched.
    """
    raw = fields.get(key)
    if raw in (None, ""):
        return None
    try:
        return Decimal(str(raw))
    except InvalidOperation as exc:
        raise ValueError(f"extracted {key} is not a number: {raw!r}") from exc


def idp_event_to_notice(
    document: dict,
    *,
    output_reader: Optional[object] = None,
    execution_arn: str | None = None,
) -> Notice:
    """Map an IDP completion event to a Notice — the ACTUAL side of the reconciliation.

    A document is EVIDENCE, not a reconciliation item, so extraction produces a Notice and never a
    case. There is no ``domain`` parameter, because a notice is not scoped to a recon
    domain.

    :param document: the IDP completion/tracking record (PascalCase; snake_case tolerated).
    :param output_reader: an IdpOutputReader (or compatible) used to read section results and page
        images from IDP output S3. When None, only the event's own high-level data is captured.
    :param execution_arn: the IDP Step-Function run id, stored for the audit trail.
    :returns: the mapped notice.
    :raises ValueError: if the document has no identifiable ObjectKey, no extractable notice date,
        or an amount that will not parse.
    """
    object_key, out_bucket, out_prefix = _derive_output_location(document)
    if not object_key:
        raise ValueError(f"IDP document missing ObjectKey/id: keys={list(document)}")

    sections, pages, _page_count = _read_sections(
        document, output_reader=output_reader, out_bucket=out_bucket, out_prefix=out_prefix
    )
    first = sections[0] if sections else {}
    fields = first.get("fields", {}) or {}

    # notice_date is the range key of the notices table's counterparty-index, so a blank one would
    # be both rejected by the model and dropped from the index — the notice would exist but the
    # agent's primary query could never return it. Raise instead: the hook re-raises, and IDP's
    # retry/DLQ gets a second chance at the extraction.
    notice_date = str(fields.get("notice_date") or fields.get("value_date") or "")
    if not notice_date:
        raise ValueError(
            f"IDP document {object_key} extracted no notice_date/value_date: fields={list(fields)}"
        )

    # None when the per-section counts could not be read AND IDP's own field is NULL. Propagated as
    # None on purpose: the interceptor refuses a write it cannot evaluate, and a defaulted number
    # here would make an unscored extraction look like a scored one.
    section_alerts = [
        s.get("confidence_alert_count")
        for s in sections
        if s.get("confidence_alert_count") is not None
    ]
    alert_total = sum(section_alerts) if section_alerts else document.get("ConfidenceAlertCount")

    # Parsed before the constructor call because `amount_type` is derived FROM them. Deriving it from
    # the raw `fields` dict instead would re-parse, and the two parses could disagree on a blank.
    amount = _opt_decimal(fields, "amount")
    global_amount = _opt_decimal(fields, "global_amount")
    fee_amount = _opt_decimal(fields, "fee_amount")

    return Notice(
        notice_id=f"idp-{object_key}",
        notice_class=first.get("classification") or "unclassified",
        # A GSI hash key cannot be blank. "unknown" keeps an unattributable notice retrievable by
        # notice_id and by reference-index rather than failing the whole extraction over a name.
        counterparty=str(fields.get("counterparty") or fields.get("borrower") or "unknown"),
        notice_date=notice_date,
        fund=_opt(fields, "fund"),
        facility=_opt(fields, "facility"),
        reference=_opt(fields, "reference"),
        amount=amount,
        currency=_opt(fields, "currency"),
        # The business activity, in the source's vocabulary. Separate from `notice_class` above, which
        # is the pipeline's classification of the DOCUMENT — see the Notice model.
        activity_type=_opt(fields, "activity_type"),
        # The facility-wide total, kept apart from `amount` so a global figure can never stand in for
        # this fund's share. `amount_type` records which of the two this notice actually supports.
        global_amount=global_amount,
        fee_amount=fee_amount,
        fee_percentage=_opt_decimal(fields, "fee_percentage"),
        amount_type=derive_amount_type(
            amount=amount, global_amount=global_amount, fee_amount=fee_amount
        ),
        # Verbatim, and never reconciled against loanx_id — see the Notice model's comment.
        facility_id_source_raw=_opt(fields, "facility_id_source_raw"),
        loanx_id=_opt(fields, "loanx_id"),
        cusip=_opt(fields, "cusip"),
        isin=_opt(fields, "isin"),
        agent_bank=_opt(fields, "agent_bank"),
        agent_contact_name=_opt(fields, "agent_contact_name"),
        agent_email=_opt(fields, "agent_email"),
        agent_telephone=_opt(fields, "agent_telephone"),
        contract_id=_opt(fields, "contract_id"),
        new_contract_id=_opt(fields, "new_contract_id"),
        notice_comment=_opt(fields, "notice_comment"),
        # The date as printed, beside the ISO value above. A conversion with no record of its input
        # cannot be audited, and manual extracts have been seen carrying Excel serials.
        notice_date_source_raw=_opt(fields, "notice_date_source_raw"),
        # Derived from THIS writer's own context, never extracted and never caller-supplied. Constant
        # on the document path: the source is not the structured feed, and extraction did the parse.
        source_system=SOURCE_SYSTEM_OTHER,
        parse_method=PARSE_METHOD_IDP,
        # `subscription_status` and `source_status_raw` are deliberately NOT set. They are the feed's
        # reference data, not document content, so they stay ABSENT until a structured-feed adapter
        # exists — and a blank subscription status is itself the signal that routing needs a human.
        # `ingestion_channel` is not set either, and not on the model: this event carries nothing that
        # identifies the delivery route, and reading the input object's metadata would be a second
        # read into the document pipeline's storage, which the decoupling rule does not sanction.
        extraction_confidence=first.get("classification_confidence"),
        confidence_alert_count=alert_total,
        source_document=object_key,
        idp_execution_arn=execution_arn or document.get("workflow_execution_arn") or "",
        idp_pages=_decimalize(pages),
    )
