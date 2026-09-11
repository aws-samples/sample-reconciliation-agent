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
from decimal import Decimal
from typing import Any, Optional

from backend.recon_core.notice_derive import (
    PARSE_METHOD_IDP,
    SOURCE_SYSTEM_OTHER,
)
from backend.recon_core.notices import Notice

logger = logging.getLogger(__name__)


def decimalize(obj: Any) -> Any:
    """Recursively convert floats to :class:`Decimal` so nested IDP data is DynamoDB-safe (boto3
    rejects Python floats outright). Walks dicts/lists in place; leaves existing Decimals
    untouched (the IDP output reader already decimalizes its result, so this must not choke on
    Decimals here).

    Public, like :func:`split_s3_uri` above, for the same reason: this is now the THIRD would-be
    home for "convert a float to Decimal" in this package -- ``tracking.py`` had a byte-identical
    private copy (now deleted; it imports this instead) and ``idp_output.py`` line ~113 reaches the
    same result through ``json.loads(json.dumps(...), parse_float=Decimal)``. Consolidating here
    stops a fourth copy from appearing and a future bug fix from having to land in three places.

    NOT interchangeable with ``idp_output.py``'s ``parse_float=Decimal`` trick: that one operates on
    a JSON string round-trip (it also happens to convert ints that arrived as JSON floats), while
    this one walks a live Python structure in place. Do not "unify" them into one call site --
    they take different inputs and are used where each module already has the matching one in hand.

    :param obj: any JSON-shaped value (dict, list, float, or scalar).
    :returns: the same structure with every float replaced by a ``Decimal`` built via ``str()``
        (to avoid binary-float imprecision); non-float values are returned unchanged.
    """
    if isinstance(obj, float):
        return Decimal(str(obj))  # via str() to avoid binary-float imprecision
    if isinstance(obj, dict):
        return {k: decimalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [decimalize(v) for v in obj]
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
            # like a mapper bug rather than an unresolved event and misdirects the whole diagnosis.
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


def idp_event_to_notice(
    document: dict,
    *,
    output_reader: Optional[object] = None,
    execution_arn: str | None = None,
    idp_tracking: dict | None = None,
) -> Notice:
    """Map an IDP completion event to a Notice — the ACTUAL side of the reconciliation.

    A document is EVIDENCE, not a reconciliation item, so extraction produces a Notice and never a
    case. There is no ``domain`` parameter, because a notice is not scoped to a recon
    domain.

    :param document: the IDP completion/tracking record (PascalCase; snake_case tolerated).
    :param output_reader: an IdpOutputReader (or compatible) used to read section results and page
        images from IDP output S3. When None, only the event's own high-level data is captured.
    :param execution_arn: the IDP Step-Function run id, stored for the audit trail.
    :param idp_tracking: the IDP pipeline's own tracking snapshot for this document (see
        ``backend/idp_hook/tracking.build_tracking_snapshot``), stored on the returned notice so
        the Documents tab can render pipeline progress without a live AppSync call. Carried
        through as-is except for ``page_count`` -- see the comment where it is folded in below.
        ``None`` when the caller has none to attach (e.g. a caller that predates this parameter).
    :returns: the mapped notice.
    :raises ValueError: if the document has no identifiable ObjectKey, no extractable notice date,
        or an amount that will not parse.
    """
    object_key, out_bucket, out_prefix = _derive_output_location(document)
    if not object_key:
        raise ValueError(f"IDP document missing ObjectKey/id: keys={list(document)}")

    sections, pages, page_count = _read_sections(
        document, output_reader=output_reader, out_bucket=out_bucket, out_prefix=out_prefix
    )
    # `page_count` used to be thrown away here as `_page_count`. `tracking.build_tracking_snapshot`
    # computes its OWN page_count from the raw event/document alone, so it cannot see the actual
    # page images `_read_sections` just read from IDP output S3 -- the one place this mapper knows
    # more than that snapshot does. Fold it in (mapper's value wins when both are known -- it is the
    # more complete source) rather than let it fall on the floor a second time.
    if idp_tracking is not None and page_count is not None:
        idp_tracking = {**idp_tracking, "page_count": page_count}
    first = sections[0] if sections else {}
    fields = first.get("fields", {}) or {}

    # None, not "", when the document printed no date of any kind: absence is what `search_notices`
    # reports as `fields_unavailable`, whereas a blank string is a value and reads as a date the
    # extractor resolved to nothing.
    #
    # ⚠️ Do NOT reach for `idp_tracking["initial_event_time"]` here. It is a PROCESSING timestamp and
    # this field is an ISSUE date; the substitution makes a stale notice appear to fall inside a recent
    # date window, and `_matches` compares a present date as a real one, so nothing reports it. Ingest
    # time is stored under its own name for readers that want it.
    notice_date = str(fields.get("notice_date") or fields.get("value_date") or "") or None

    # None when the per-section counts could not be read AND IDP's own field is NULL. Propagated as
    # None on purpose: the interceptor refuses a write it cannot evaluate, and a defaulted number
    # here would make an unscored extraction look like a scored one.
    section_alerts = [
        s.get("confidence_alert_count")
        for s in sections
        if s.get("confidence_alert_count") is not None
    ]
    alert_total = sum(section_alerts) if section_alerts else document.get("ConfidenceAlertCount")

    # Everything the extractor read, per section, for the Documents tab to render directly. The
    # values and their per-field confidences are already in hand here -- `_read_sections` kept the
    # flattened records rather than reducing them away -- so this embeds what would otherwise be a
    # live call back into the pipeline's API for every drawer open.
    #
    # `mean_confidence`/`alert_count` are carried PER SECTION and are not the notice-level
    # `extraction_confidence`/`confidence_alert_count` below: those are the first section's score and
    # the sum across sections respectively, which is what the interceptor and the prompt read.
    idp_sections = decimalize(
        [
            {
                "section_id": s.get("section_id"),
                "classification": s.get("classification"),
                "page_ids": s.get("page_indices") or [],
                "fields": s.get("fields") or {},
                "confidences": s.get("field_confidences") or [],
                "mean_confidence": s.get("classification_confidence"),
                "alert_count": s.get("confidence_alert_count") or 0,
            }
            for s in sections
        ]
    )

    return Notice(
        notice_id=f"idp-{object_key}",
        notice_class=first.get("classification") or "unclassified",
        # A GSI hash key cannot be blank. "unknown" keeps an unattributable notice retrievable by
        # notice_id and by reference-index rather than failing the whole extraction over a name.
        counterparty=str(fields.get("counterparty") or fields.get("borrower") or "unknown"),
        notice_date=notice_date,
        reference=_opt(fields, "reference"),
        # ⚠️ The three extracted fields above are the complete set this mapper reads by name, and they
        # are read only because they are DynamoDB index key attributes. Do not add a fourth: every
        # extracted field is carried verbatim in `idp_sections` below, `search_notices` resolves filters
        # against it, and a name added here is one recon must keep in step with a configuration in
        # another repository. See PROMOTED_EXTRACTED_FIELDS in backend/recon_core/notices.py.
        #
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
        idp_pages=decimalize(pages),
        idp_sections=idp_sections,
        idp_tracking=idp_tracking,
    )
