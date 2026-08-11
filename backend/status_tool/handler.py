"""recon_update_status tool: the single guarded write path for case-lifecycle transitions.

Registered as the ``recon-status`` target on the egress tools gateway. This tool is
**platform-only**: AgentCore Policy (Cedar) permits it exclusively for platform principals
(the frontend BFF task role) and explicitly forbids the agent/worker roles — the model can
never move its own case. Routing the BFF's status changes through this tool (instead of raw
DynamoDB updates) gives every human-driven transition the same guarantees the worker paths
already have: ``can_transition`` enforcement, race-safe conditional writes, and an
append-only audit row that names the actor.

Contract: a disallowed transition is NOT an error — the tool returns
``{"transitioned": false, "status": <current>}`` so the caller can surface a conflict (the
BFF maps it to HTTP 409). Unknown statuses and missing cases are errors.
"""

import os

from backend.recon_core.cases import CaseStore
from backend.recon_core.status import CaseStatus


def _store() -> CaseStore:
    """Build the case store from the Lambda environment.

    :returns: a CaseStore bound to the cases + audit tables.
    """
    return CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )


def handle(event: dict, _context=None) -> dict:
    """Perform one guarded case-status transition.

    Gateway Lambda targets receive the tool arguments as the event dict.

    :param event: ``{item_id: str, new_status: str, comment?: str, actor?: str}``.
    :param _context: Lambda context (unused).
    :returns: ``{item_id, status, transitioned}`` — ``status`` is the case's status AFTER the
        call (the new status when transitioned, the unchanged current status otherwise).
    :raises ValueError: on a missing/unknown ``item_id`` or ``new_status``.
    """
    item_id = (event.get("item_id") or "").strip()
    raw_status = (event.get("new_status") or "").strip()
    if not item_id:
        raise ValueError("item_id is required")
    try:
        new_status = CaseStatus(raw_status)
    except ValueError:
        allowed = ", ".join(s.value for s in CaseStatus)
        raise ValueError(f"unknown new_status {raw_status!r}; expected one of: {allowed}")

    actor = (event.get("actor") or "platform").strip() or "platform"
    comment = (event.get("comment") or "").strip()
    note = f"{actor}: {comment}" if comment else actor

    store = _store()
    transitioned = store.transition("item_id", item_id, new_status, note=note)
    # status() raises KeyError for a missing case — surfaced as a tool error by the gateway.
    return {
        "item_id": item_id,
        "status": store.status(item_id).value,
        "transitioned": transitioned,
    }
