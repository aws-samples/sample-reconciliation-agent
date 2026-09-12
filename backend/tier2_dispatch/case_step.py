"""The two guarded case writes the Tier-2 map run performs: claim, and mark-failed.

A Lambda rather than ASL ``dynamodb:updateItem`` tasks, because neither write is a bare update. Both go
through ``CaseStore``, which owns ``can_transition`` enforcement, the conditional write that makes a
lost race a normal outcome rather than an error, and the append-only audit row. Expressing that in ASL
would be a second copy of the case state machine's rules with no tests over it — and the repo already
routes every human-driven transition through one guarded path for the same reason.

Two actions, one function, because they are two steps of one workflow and share a table binding.
"""

import json
import logging
import os

from backend.recon_core.cases import CaseStore
from backend.recon_core.status import CaseStatus

logger = logging.getLogger(__name__)


def _store() -> CaseStore:
    """Build the case store from the Lambda environment.

    :returns: a CaseStore bound to the cases + audit tables.
    """
    return CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )


def _claim(*, item_id: str) -> dict:
    """Move PENDING -> IN_PROGRESS and return the FULL item the agent must investigate.

    ``claimed: false`` is a NORMAL outcome, not an error, and the state machine branches to Succeed on
    it. It means another run (or the frontend's Retry) already moved this case, which is exactly what
    makes re-running a map over the same collected list cost nothing. Raising instead would turn
    idempotency into a run of spurious failures.

    ⚠️ The ``item`` in the return value is load-bearing, and its absence was a real bug. The collected
    S3 list carries only ``{item_id, domain, session_id}`` — deliberately, so a 5000-item run stays
    small — but the agent calls ``ReconItem.model_validate`` on whatever it is handed, so passing the
    collected stub made every investigation fail with ``sides Field required``. The full item lives on
    the case row (``CaseStore.open`` stores ``item.model_dump()``), so it is read here, in the one step
    that already touches the row, rather than bloating the map's input or being fetched twice.

    Reading it at CLAIM time also matches what the console promises for a retry — "re-runs the
    investigation from the item as stored" — and it serves both backends, which was the other half of
    the bug: the harness branch takes the same item and would have failed identically.

    :param item_id: the case key.
    :returns: ``{"claimed": bool, "item_id": str, "item": dict}``. ``item`` is ``{}`` when the case was
        not claimed, because nothing will read it on that path.
    :raises KeyError: when no case row exists — a collected item id that has no case is a real fault,
        not a race, because collect reads the case table itself.
    """
    store = _store()
    claimed = store.transition("item_id", item_id, CaseStatus.IN_PROGRESS)
    if not claimed:
        logger.info("case %s was already claimed; skipping", item_id)
        return {"claimed": False, "item_id": item_id, "item": {}}
    return {"claimed": True, "item_id": item_id, "item": _stored_item(store=store, item_id=item_id)}


def _stored_item(*, store: CaseStore, item_id: str) -> dict:
    """Read the item snapshot off the case row, JSON-safe.

    DynamoDB returns numbers as ``Decimal`` through the resource API, and a Lambda return value has to
    be JSON-serialisable, so the snapshot is round-tripped with ``default=str``. Stringifying is safe
    here for the same reason it is safe in ``tier1.invoke_agent._dispatch``: the agent re-validates the
    payload through pydantic, which coerces the strings back to numbers.

    :param store: the case store to read through.
    :param item_id: the case key.
    :returns: the stored ``ReconItem`` as a JSON-safe dict.
    :raises KeyError: when the case row has no item snapshot at all. Failing loudly beats handing the
        agent an empty dict, which is exactly the failure this function exists to prevent.
    """
    item = store.get(item_id).get("item")
    if not item:
        raise KeyError(f"case {item_id} has no stored item snapshot")
    return json.loads(json.dumps(item, default=str))


def _fail(*, item_id: str, reason: str) -> dict:
    """Mark a case FAILED after its investigation died or its task token timed out.

    Reached from the child's ``Catch``, which is the backstop for the case the agent cannot report
    itself: if the container died outright, nothing in it ran to call ``SendTaskFailure`` or to write
    the row. ``mark_failed`` is conditional on IN_PROGRESS, so a proposal that landed just before the
    state gave up is never overwritten.

    :param item_id: the case key.
    :param reason: human-readable cause, stored on the case for the analyst.
    :returns: ``{"failed": bool, "item_id": str}`` — ``false`` when the case had already moved on.
    """
    failed = _store().mark_failed(item_id, reason=reason)
    if not failed:
        logger.warning(
            "case %s not marked FAILED (no longer IN_PROGRESS); a result landed first: %s",
            item_id,
            reason,
        )
    return {"failed": bool(failed), "item_id": item_id}


def handle(event, _context):
    """Perform one guarded case write for the map run.

    :param event: ``{"action": "claim"|"fail", "item_id": str, "reason": str}``. ``reason`` is only
        read by ``fail`` and carries the ASL error payload from the child's Catch.
    :param _context: the Lambda context (unused).
    :returns: the action's result dict.
    :raises KeyError: when ``action`` or ``item_id`` is absent.
    :raises ValueError: on an unknown action. There is no safe default here: silently treating a typo
        as "claim" would start an investigation the workflow believed it had cancelled.
    """
    action = event["action"]
    item_id = str(event["item_id"])
    if action == "claim":
        return _claim(item_id=item_id)
    if action == "fail":
        # The Catch payload is a dict (Error/Cause) or a bare string depending on the failure; both
        # arrive here already stringified by the state's parameters.
        return _fail(item_id=item_id, reason=str(event.get("reason", "") or "investigation failed"))
    raise ValueError(f"unknown case_step action: {action!r}")
