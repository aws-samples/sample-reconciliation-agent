"""IDP post-processing hook. IDP invokes this on Step-Function SUCCEEDED with the completion
event; we map the document to a ReconItem and write it through the normal intake path.

IDP coupling: the inbound invocation (trigger) plus a single READ-ONLY read of IDP's output
bucket at ingest to embed the extracted field values + page-image locations into the item
(user-approved — the detail screen renders these directly, no on-demand IDP call). The recon
runtime/agent still never reads IDP storage.
"""

import json
import logging
import os

from backend.idp_hook.idp_output import IdpOutputReader
from backend.idp_hook.mapper import idp_event_to_recon_item
from backend.recon_core.cases import CaseStore
from backend.recon_core.ddb import ItemStore

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _redrive_case(item, *, agent_arn: str) -> str:
    """Re-open + re-investigate a case after a genuine IDP reprocess.

    Resets the (possibly terminal) case to PENDING with the new extraction, then, unless it
    aged out at the reprocess cap, advances PENDING->IN_PROGRESS and dispatches the agent
    worker — the same round-trip the items stream does on first ingest, done directly here
    because a MODIFY of an already-open case does not re-open it via tier1 (cases.open is
    put-if-absent).

    :returns: ``"redriven"``, ``"aged"``, or ``"redrive_no_case"`` when no case exists yet.
    """
    cases = CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )
    try:
        cases.status(item.item_id)  # KeyError if the item exists but a case never opened
    except KeyError:
        # No case (unusual) — let the normal first-ingest path handle it on the item write.
        return "redrive_no_case"

    cap = int(os.environ.get("REPROCESS_CAP", "3"))
    outcome = cases.redrive(item, reprocess_cap=cap)
    if outcome == "redriven" and agent_arn and os.environ.get("AGENT_WORKER_FUNCTION"):
        # Lazy import: invoke_agent lives in the tier1 package.
        from backend.recon_core.status import CaseStatus
        from backend.tier1.invoke_agent import invoke_recon_agent

        # redrive() already set PENDING; advance PENDING->IN_PROGRESS + dispatch (guarded).
        if cases.transition("item_id", item.item_id, CaseStatus.IN_PROGRESS, note="IDP reprocess"):
            invoke_recon_agent(
                agent_arn=agent_arn, item=item, cases=cases, already_in_progress=True
            )
    return outcome


def handle(event, _context):
    """Map the IDP completion event to a ReconItem and write it; re-drive on a genuine reprocess.

    First ingest writes the item (items stream opens + escalates the case). A NEW IDP run of an
    already-ingested document (distinct ``detail.executionArn``) overwrites the item and
    re-drives its case to PENDING->IN_PROGRESS — even from a terminal state. A re-delivered
    identical completion event is a no-op (idempotency preserved).

    Returns ``{"written": n, "redriven": m, "outcome": ...}``. Re-raises unexpected errors so
    IDP's retry/DLQ engages.
    """
    # Log the raw event once — the real IDP shape was undocumented and cost us a silent
    # field-drop; keep this so future shape changes are diagnosable from CloudWatch.
    logger.info("idp-hook event: %s", json.dumps(event, default=str)[:4000])

    detail = event.get("detail", {})
    if detail.get("status") != "SUCCEEDED":
        return {"written": 0, "redriven": 0, "outcome": "not_succeeded"}
    output = detail.get("output")
    parsed = json.loads(output) if isinstance(output, str) else (output or {})
    document = parsed.get("document") or parsed  # tolerate either shape
    domain = os.environ.get("RECON_DOMAIN")  # single deployment domain; None -> "unknown"
    execution_arn = detail.get("executionArn")  # unique per IDP run — reprocess discriminator

    # Reader is used by the mapper to pull extracted values from IDP output S3 at ingest. If the
    # bucket isn't configured we still capture high-level info (classification/sections) from the
    # event itself.
    reader = IdpOutputReader()

    store = ItemStore(table_name=os.environ.get("ITEMS_TABLE", "recon-items"))
    item = idp_event_to_recon_item(
        document, domain=domain, output_reader=reader, execution_arn=execution_arn
    )

    # Copy page previews into recon's own assets bucket so the UI serves them same-origin
    # (best-effort — the ingest never fails on a preview copy).
    assets_bucket = os.environ.get("ASSETS_BUCKET", "")
    pages = item.attributes.get("idp_pages") or []
    if assets_bucket and pages:
        item.attributes["idp_pages"] = reader.copy_pages(
            pages, dest_bucket=assets_bucket, item_id=item.item_id
        )

    disposition = store.put_and_detect_reprocess(item)
    if disposition == "created":
        # First ingest: the items stream opens the case and escalates (unchanged path).
        logger.info("idp-hook wrote item_id=%s written=1 (created)", item.item_id)
        return {"written": 1, "redriven": 0, "outcome": "created"}
    if disposition == "duplicate":
        # Re-delivered identical completion event — preserve the original idempotency guard.
        logger.info("idp-hook item_id=%s duplicate event, no-op", item.item_id)
        return {"written": 0, "redriven": 0, "outcome": "duplicate"}

    # disposition == "reprocessed": item overwritten with the new extraction; re-drive the case.
    agent_arn = os.environ.get("AGENT_RUNTIME_ARN", "")
    outcome = _redrive_case(item, agent_arn=agent_arn)
    logger.info("idp-hook item_id=%s reprocessed, re-drive outcome=%s", item.item_id, outcome)
    return {"written": 0, "redriven": 1, "outcome": outcome}
