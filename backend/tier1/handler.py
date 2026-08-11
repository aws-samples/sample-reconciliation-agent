"""Tier-1 Lambda: DynamoDB-Stream consumer that reconciles or escalates each item.

Triggered by the recon-items stream. For each new item it runs the deterministic engine and
either opens an AUTO_CLEARED (terminal) case or opens a PENDING case and escalates to the
Tier-2 agent. Case opens are idempotent, so redelivered stream records are no-ops.
"""

import os

from boto3.dynamodb.types import TypeDeserializer

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem
from backend.recon_core.status import CaseStatus
from backend.tier1.config import tier1_enabled
from backend.tier1.engine import reconcile

# Deterministic rules; loaded from env/SSM in prod, inline default keeps Tier-1 deterministic.
_RULES = {"cash": {"match_attr": "amount", "tolerance": "0.05", "category": "amount-match"}}

_DESER = TypeDeserializer()


def _new_image(record: dict) -> dict:
    """Deserialize a DynamoDB Stream NewImage (typed AttributeValues) to a plain dict."""
    image = record["dynamodb"]["NewImage"]
    return {k: _DESER.deserialize(v) for k, v in image.items()}


def handle(event, _context):
    """Stream consumer: run Tier-1 per item; write case; escalate to Tier-2 on miss.

    Idempotent — a case is opened only if one does not already exist for the item.
    """
    cases = CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )
    agent_arn = os.environ.get("AGENT_RUNTIME_ARN")
    # Read the deterministic-tier toggle once per batch (cached inside config).
    deterministic_on = tier1_enabled()
    results = []
    for record in event.get("Records", []):
        if record.get("eventName") not in ("INSERT", "MODIFY"):
            continue
        item = ReconItem.model_validate(_new_image(record))
        # When the deterministic tier is disabled, skip auto-matching entirely and send
        # every item to the Tier-2 agent (result.resolved forced False).
        result = reconcile(item, rules=_RULES) if deterministic_on else None

        # Deterministic GL match for sides-less (IDP) items: look the document up in the
        # mocked general ledger; an amount match within tolerance auto-clears without the LLM.
        gl_row = None
        if deterministic_on and (result is None or not result.resolved) and not item.sides:
            if os.environ.get("GL_QUERY_FUNCTION"):
                from backend.tier1.gl_match import default_invoker, fetch_candidates, gl_lookup

                gl_row = gl_lookup(item, invoker=default_invoker)
                if gl_row is None:
                    # Attach GL context rows so the agent reasons over real ledger data.
                    candidates = fetch_candidates(item, invoker=default_invoker)
                    if candidates:
                        item.attributes["gl_candidates"] = candidates

        if (result is not None and result.resolved) or gl_row is not None:
            category = result.category if (result is not None and result.resolved) else "gl-match"
            created = cases.open(item, status=CaseStatus.AUTO_CLEARED, tier=1, category=category)
            results.append(
                {
                    "item_id": item.item_id,
                    "status": "AUTO_CLEARED" if created else "DUPLICATE_SKIPPED",
                    "escalated": False,
                }
            )
        else:
            created = cases.open(item, status=CaseStatus.PENDING, tier=2)
            if created and agent_arn:
                # Tier-2: advance state and async-dispatch the agent runtime (Task 13a).
                from backend.tier1.invoke_agent import invoke_recon_agent

                invoke_recon_agent(agent_arn=agent_arn, item=item, cases=cases)
            results.append(
                {
                    "item_id": item.item_id,
                    "status": "PENDING" if created else "DUPLICATE_SKIPPED",
                    "escalated": bool(created),
                }
            )
    return {"results": results}
