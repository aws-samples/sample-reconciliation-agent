"""IDP post-processing hook. IDP invokes this on Step-Function SUCCEEDED with the completion
event; we map the document to a Notice — EVIDENCE on the actual side of the reconciliation — and
store it in recon-notices.

This hook deliberately does NOT create a reconciliation case. An extracted document is not a
break; it is one input the deterministic matcher and the agent read when a break already exists
-- extraction produces evidence, not a case. recon-notices has no DynamoDB stream, so there is no
path from here to
cases.open, and that absence is the control — not a flag anyone can flip.

IDP coupling: the inbound invocation (trigger) plus a single READ-ONLY read of IDP's output
bucket at ingest to embed the extracted field values + page-image locations into the notice
(user-approved — the detail screen renders these directly, no on-demand IDP call). The recon
runtime/agent still never reads IDP storage.
"""

import json
import logging
import os

from backend.idp_hook.idp_output import IdpOutputReader
from backend.idp_hook.mapper import idp_event_to_notice
from backend.recon_core.notices import NoticeStore

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handle(event, _context) -> dict:
    """Map an IDP completion event to a Notice and store it.

    Re-delivery needs no idempotency guard: ``notice_id`` is deterministic (``idp-<ObjectKey>``)
    and the put is an unconditional overwrite, so the same event lands on the same row. A genuine
    reprocess (a new IDP run) simply replaces the stale extraction — there is no case to re-drive.

    :param event: the EventBridge event carrying IDP's Step-Function completion detail.
    :param _context: the Lambda context (unused).
    :returns: ``{"written": n, "notice_id": id_or_None}``.
    :raises Exception: re-raises unexpected errors so IDP's retry/DLQ engages. In particular a
        document with no extractable notice date raises rather than storing an unindexable row.
    """
    # Log the raw event once — the real IDP shape was undocumented and cost us a silent
    # field-drop; keep this so future shape changes are diagnosable from CloudWatch.
    logger.info("idp-hook event: %s", json.dumps(event, default=str)[:4000])

    detail = event.get("detail", {})
    if detail.get("status") != "SUCCEEDED":
        return {"written": 0, "notice_id": None}
    output = detail.get("output")
    parsed = json.loads(output) if isinstance(output, str) else (output or {})
    document = parsed.get("document") or parsed  # tolerate either shape
    execution_arn = detail.get("executionArn")  # the IDP run id, kept for the audit trail

    # Reader pulls extracted values from IDP output S3 at ingest. Without a reachable bucket we
    # still capture what the event itself carries (classification/sections).
    reader = IdpOutputReader()
    # IDP compresses any output too large for Step Functions' 256 KB cap, leaving only a pointer in
    # the event. Resolve it BEFORE mapping: the stand-in's `sections` is a list of id strings, not
    # records, and it names neither the output bucket nor the input key. Every succeeded execution in
    # recon-dev is compressed, so this is the normal path.
    document = reader.resolve_document(document)
    notice = idp_event_to_notice(document, output_reader=reader, execution_arn=execution_arn)

    # Copy page previews into recon's own assets bucket so the UI serves them same-origin
    # (best-effort — ingest never fails on a preview copy). This S3 read is the one sanctioned
    # IDP coupling; see the module docstring.
    assets_bucket = os.environ.get("ASSETS_BUCKET", "")
    if assets_bucket and notice.idp_pages:
        notice.idp_pages = reader.copy_pages(
            notice.idp_pages, dest_bucket=assets_bucket, item_id=notice.notice_id
        )

    # os.environ[...] not .get(..., "recon-notices"): a misconfigured hook must fail its invocation
    # and land in the DLQ, not silently write to a table name that is only right in dev.
    NoticeStore(table_name=os.environ["NOTICES_TABLE"]).put(notice=notice)
    logger.info("idp-hook wrote notice_id=%s class=%s", notice.notice_id, notice.notice_class)
    return {"written": 1, "notice_id": notice.notice_id}
