"""set_draw_status write tool: records a draw/ledger status mutation in the GL status overlay.

Registered as the ``set-draw-status`` tool on the AgentCore Gateway. The authoritative GL
(S3 + Athena) is read-only; this Lambda writes to a small DynamoDB overlay keyed by
``reference`` that ``search_ledger`` merges onto its results. Writes are idempotent (one row
per reference) so the autonomous-execution and human-approve paths can overlap safely.

Every caller reaches this Lambda THROUGH the AgentCore Gateway — there is no direct-invoke
path — and the gateway is the trust boundary (verified live in ENFORCE mode, 2026-07-26):
  * **AgentCore Policy (Cedar)**: ``recon_write_gate`` permits agent/worker writes only when
    ``context.input.confidence >= threshold``; ``recon_write_human`` permits the BFF
    principal (a human decision is the authorization — no confidence argument).
  * **Gateway REQUEST interceptor**: provenance — the ``reference`` being written must equal
    the persisted ``proposed_action.reference`` for the item, so no caller can redirect a
    write to an arbitrary ledger row (``backend/gateway_interceptor/handler.py``).

This Lambda therefore keeps only tool-local input validation: the status allowlist (a value
constraint, not an authorization decision) and the idempotent write itself. The duplicate
provenance check it used to carry was removed once the interceptor's enforce mode was
verified — one trust boundary, enforced in one place.
"""

import os

import boto3

# The only statuses a caller (agent or human-approve) may set. Guards the write against a
# model proposing an out-of-domain status; mirrored by the gateway tool schema description.
ALLOWED_STATUSES = frozenset({"Cancelled", "Confirmed", "OnHold", "Amended"})


def handle(event, _context=None, *, ddb=None, now: str | None = None) -> dict:
    """Idempotently write a draw/ledger status record to the overlay table.

    :param event: tool input ``{reference, status, reason?, item_id?}``.
    :param ddb: injectable DynamoDB resource (tests); real resource by default.
    :param now: ISO timestamp to stamp (injected in tests; caller-supplied in prod so the
        handler stays deterministic and never calls a bare ``datetime.now()``).
    :returns: the persisted record.
    :raises ValueError: on a blank ``reference`` or an out-of-allowlist ``status``.
    """
    reference = (event.get("reference") or "").strip()
    if not reference:
        raise ValueError("set_draw_status requires a non-empty reference")
    status = event.get("status")
    if status not in ALLOWED_STATUSES:
        raise ValueError(
            f"status must be one of {sorted(ALLOWED_STATUSES)}, got {status!r}"
        )

    ddb = ddb or boto3.resource("dynamodb")
    record = {
        "reference": reference,
        "item_id": event.get("item_id") or "",
        "status": status,
        "reason": event.get("reason") or "",
        "updated_at": now or "",
    }
    ddb.Table(os.environ["GL_STATUS_TABLE"]).put_item(Item=record)  # idempotent on reference (PK)
    return record
