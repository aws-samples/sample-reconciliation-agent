"""IDP-completion-event → ReconItem mapper.

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
screen renders them directly, with no on-demand IDP call. A legacy snake_case shape is still
tolerated for older fixtures/tests.
"""

import logging
from decimal import Decimal
from typing import Optional

from backend.recon_core.schema import ReconItem

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


def _s3_uri_to_bucket_prefix(uri: str) -> tuple[str, str]:
    """Split an ``s3://bucket/key`` URI into (bucket, key). Returns ('','') if not an s3 URI."""
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
        bucket, key = _s3_uri_to_bucket_prefix(sample_uri)
        # key looks like "<ObjectKey>/sections/1/result.json" -> prefix is "<ObjectKey>"
        prefix = key.split("/sections/")[0].split("/pages/")[0]
        return object_key, bucket, prefix
    # Fallback: explicit fields (also covers the legacy snake_case fixture).
    bucket = document.get("output_bucket", "")
    prefix = document.get("input_key", "") or (object_key or "")
    return object_key, bucket, prefix


def idp_event_to_recon_item(
    document: dict,
    *,
    domain: str | None,
    output_reader: Optional[object] = None,
    execution_arn: str | None = None,
) -> ReconItem:
    """Map an IDP completion event to a canonical ReconItem, embedding IDP detail at ingest.

    :param document: the IDP completion/tracking record (PascalCase; snake_case tolerated).
    :param domain: single deployment domain stamped on the item ('unknown' if None).
    :param output_reader: an IdpOutputReader (or compatible) used to read section results +
        page images from IDP output S3. When provided and the S3 location is known, the
        extracted field values are embedded. When None, only the high-level info from the event
        (classification, section list, page count, S3 location) is captured.
    :param execution_arn: the IDP Step-Function run id (``detail.executionArn``) — stored so a
        later reprocess (a NEW run of the same document) can be distinguished from a re-delivered
        duplicate event. Falls back to the document's ``workflow_execution_arn`` when absent.
    :returns: a ReconItem with idp_* attributes populated.
    :raises ValueError: if the document has no identifiable id/ObjectKey.
    """
    object_key, out_bucket, out_prefix = _derive_output_location(document)
    if not object_key:
        raise ValueError(f"IDP document missing ObjectKey/id: keys={list(document)}")

    raw_ref = f"s3://{out_bucket}/{out_prefix}/" if out_bucket else ""
    refs = [f"idp:documentId={object_key}", f"idp:objectKey={object_key}"]
    if raw_ref:
        refs.append(f"idp:output={raw_ref}")

    # High-level section list from the event itself (classification + result URI per section).
    event_sections = document.get("Sections") or document.get("sections") or []

    # Enrich from IDP output S3 when a reader is available: embed extracted field VALUES + pages.
    # A read failure must NOT drop the item — fall back to the high-level event data below, so a
    # transient IDP-S3 issue still yields a usable case (classification/sections from the event).
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
        except Exception as exc:  # noqa: BLE001 - degrade gracefully, never drop the item
            logger.warning("IDP output read failed for %s: %s", raw_ref, exc)

    # If enrichment wasn't available, fall back to whatever the event carried per section.
    if not enriched_sections:
        for s in event_sections:
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

    first_section = enriched_sections[0] if enriched_sections else {}
    first_class = first_section.get("classification")
    first_fields = first_section.get("fields", {})
    # Classification-slot confidence for the first section, as resolved by the output reader
    # (document_class.confidence when IDP emits one, else the mean per-field extraction
    # confidence from explainability_info). Omitted when absent so pre-Assessment documents don't
    # carry a misleading zero — the composite renormalizes instead.
    first_conf = first_section.get("classification_confidence")
    # Low-confidence extracted fields across ALL sections: the agent may reason over any section,
    # so the penalty must reflect the whole document. The event's ConfidenceAlertCount is not
    # emitted by IDP (NULL on every live item, leaving the 10% penalty permanently inert), so it
    # is only a fallback for the event-only path where no section results were read.
    section_alerts = [
        s.get("confidence_alert_count")
        for s in enriched_sections
        if s.get("confidence_alert_count") is not None
    ]
    alert_total = sum(section_alerts) if section_alerts else document.get("ConfidenceAlertCount")

    attributes = {
        "idp_class": first_class,  # opaque; recon never branches on it
        "idp_attributes": first_fields,  # extracted field values of the first section
        "idp_sections": enriched_sections,  # per-section classification + fields
        "idp_pages": pages,  # page-image s3 uris for the preview
        "idp_page_count": page_count,
        "idp_confidence_alert_count": alert_total,
        "idp_workflow_status": document.get("WorkflowStatus"),
        "idp_raw_ref": raw_ref,
        # Per-run id: distinguishes a genuine IDP reprocess (new run) from a re-delivered
        # duplicate completion event, so the hook can re-drive the case only on a real rerun.
        "idp_execution_arn": execution_arn or document.get("workflow_execution_arn") or "",
    }
    if first_conf is not None:
        attributes["idp_classification_confidence"] = first_conf

    return ReconItem(
        item_id=f"idp-{object_key}",
        domain=domain or "unknown",
        sides=[],
        source_refs=refs,
        attributes=_decimalize(attributes),
        tier=1,
    )
