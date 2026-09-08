"""Tier-1 Lambda: the DynamoDB Stream consumer that either reconciles an item or escalates it.

The recon-items stream triggers this. Each new item goes through the deterministic engine, and one
of two things happens: the item auto-clears into a terminal case, or it opens a PENDING case and is
escalated to the Tier-2 agent. Opening a case is idempotent, so a redelivered stream record is a
no-op rather than a duplicate.
"""

import os

from boto3.dynamodb.types import TypeDeserializer

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem
from backend.recon_core.status import CaseStatus
from backend.tier1.classify import break_record, classify_break
from backend.tier1.config import tier1_enabled
from backend.tier1.engine import ESCALATION_TIER1_DISABLED, reconcile

# The deterministic rule set, one entry per domain. Production loads this from the environment or
# SSM; the inline default is what keeps Tier-1 deterministic when nothing has been configured.
_RULES = {"cash": {"match_attr": "amount", "tolerance": "0.05", "category": "amount-match"}}

_DESER = TypeDeserializer()


def _new_image(record: dict) -> dict:
    """Turn a DynamoDB Stream NewImage of typed AttributeValues into a plain dict.

    Note what the deserializer produces: every numeric attribute comes back as a ``Decimal``, never
    an int or float. Anything downstream that filters on value type has to accept Decimal or it will
    drop every amount on the item.

    :param record: one stream record, which must carry ``dynamodb.NewImage``.
    :returns: the image as a plain dict of Python values.
    """
    image = record["dynamodb"]["NewImage"]
    return {k: _DESER.deserialize(v) for k, v in image.items()}


def handle(event, _context):
    """Run Tier-1 over a batch of stream records, writing a case for each and escalating the misses.

    The whole handler is idempotent: a case is opened only when one does not already exist for the
    item, so a redelivered batch changes nothing.

    :param event: the DynamoDB Stream event, whose ``Records`` this iterates.
    :param _context: the Lambda context, unused.
    :returns: ``{"results": [...]}``, one entry per processed record naming the item, the status it
        landed in, and whether it was escalated.
    """
    cases = CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )
    agent_arn = os.environ.get("AGENT_RUNTIME_ARN")
    # Read the deterministic-tier toggle once for the whole batch rather than per record.
    deterministic_on = tier1_enabled()
    results = []
    for record in event.get("Records", []):
        if record.get("eventName") not in ("INSERT", "MODIFY"):
            continue
        item = ReconItem.model_validate(_new_image(record))
        # With the deterministic tier disabled there is no auto-matching at all, and every item goes
        # to the Tier-2 agent. A None result is what carries that decision through the rest of the
        # loop.
        result = reconcile(item, rules=_RULES) if deterministic_on else None

        # Deterministic ledger match for items that arrived with no sides, i.e. extracted documents.
        # Look the document up in the general ledger; an amount match inside tolerance auto-clears it
        # without involving the LLM at all.
        gl_row, gl_reason = None, None
        if deterministic_on and (result is None or not result.resolved) and not item.sides:
            if os.environ.get("GL_QUERY_FUNCTION"):
                from backend.tier1.gl_match import default_invoker, fetch_candidates, gl_lookup

                gl_match = gl_lookup(item, invoker=default_invoker)
                gl_row, gl_reason = gl_match.row, gl_match.reason
                if gl_row is None:
                    # No single clean match, so attach the near-miss ledger rows. The agent then
                    # reasons over real ledger data instead of guessing at what the ledger holds.
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
            # Both tier1_* keys go onto the item before the case is opened, so the case record and
            # both Tier-2 backends carry them from the start rather than picking them up later. When
            # the ledger lookup and the engine both produced a reason, the ledger one wins: it names
            # the more specific failure.
            if not deterministic_on:
                reason = ESCALATION_TIER1_DISABLED
            else:
                reason = gl_reason or (result.escalation_reason if result else None)
            item.attributes["tier1_escalation_reason"] = reason
            # Deterministic break classification. This is safe to run on a stream shard because it
            # is plain Python: no catalog read, no network call, no cache. When no rule matches, the
            # key is simply absent and the agent classifies from scratch, which is what it did before
            # the hint existed. The whole step is skipped when the deterministic tier is off, so the
            # toggle means "Tier-1 contributes nothing" rather than "nothing except a hint".
            if deterministic_on:
                break_type = classify_break(break_record(item).fields)
                if break_type:
                    item.attributes["tier1_break_type"] = break_type
            created = cases.open(item, status=CaseStatus.PENDING, tier=2)
            if created and agent_arn:
                # Hand off to Tier-2: advance the case state, then dispatch the agent runtime
                # asynchronously so this shard is not held open for the investigation.
                from backend.tier1.invoke_agent import invoke_recon_agent

                invoke_recon_agent(agent_arn=agent_arn, item=item, cases=cases)
            results.append(
                {
                    "item_id": item.item_id,
                    "status": "PENDING" if created else "DUPLICATE_SKIPPED",
                    "escalated": bool(created),
                    "reason": reason,
                }
            )
    return {"results": results}
