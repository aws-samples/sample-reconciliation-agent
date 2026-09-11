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


def _auto_clear_evidence(
    *,
    resolved_by_rule: bool,
    rule_match: dict[str, str] | None,
    gl_evidence: dict[str, str] | None,
    gl_row: dict | None,
) -> dict:
    """Assemble the evidence explaining why an item auto-cleared, for persistence on the case.

    Both auto-clear paths produce a comparison and a margin, so both are described with a
    ``matched_on`` discriminator and a shared ``difference``/``tolerance`` pair. The case screen then
    renders one shape instead of branching on the category.

    Raises rather than returning a partial record. An auto-cleared case with no explanation is the
    exact defect this evidence exists to remove, and a silent empty dict would reintroduce it one
    refactor later while every test still passed.

    :param resolved_by_rule: True when the deterministic engine's rule cleared the item, False when
        the general-ledger lookup did.
    :param rule_match: the engine's comparison record, required when ``resolved_by_rule`` is True.
    :param gl_evidence: the ledger lookup's comparison record, required otherwise.
    :param gl_row: the single matched ledger row, required otherwise.
    :returns: the evidence to persist as the case's ``tier1_match``.
    :raises ValueError: when the path that resolved the item supplied no comparison record.
    """
    if resolved_by_rule:
        if rule_match is None:
            raise ValueError(
                "the Tier-1 engine reported a resolved item with no match evidence; "
                "reconcile() must populate Tier1Result.match on every resolved path"
            )
        return {"matched_on": "rule", **rule_match}
    if gl_evidence is None or gl_row is None:
        raise ValueError(
            "the general-ledger lookup reported a matched row with no match evidence; "
            "gl_lookup() must populate GlMatch.match alongside GlMatch.row"
        )
    # Every ledger value is stringified. The query Lambda returns JSON, so an amount arrives as a
    # float, and boto3 refuses to write a float to DynamoDB.
    return {
        "matched_on": "general_ledger",
        **gl_evidence,
        "ledger_row": {k: str(v) for k, v in gl_row.items()},
    }


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
    # No AGENT_RUNTIME_ARN read here any more: this consumer does not dispatch, so it has no use for
    # the runtime's identity. The map run owns that.
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
        gl_row, gl_reason, gl_evidence = None, None, None
        if deterministic_on and (result is None or not result.resolved) and not item.sides:
            if os.environ.get("GL_QUERY_FUNCTION"):
                from backend.tier1.gl_match import default_invoker, fetch_candidates, gl_lookup

                gl_match = gl_lookup(item, invoker=default_invoker)
                gl_row, gl_reason, gl_evidence = gl_match.row, gl_match.reason, gl_match.match
                if gl_row is None:
                    # No single clean match, so attach the near-miss ledger rows. The agent then
                    # reasons over real ledger data instead of guessing at what the ledger holds.
                    candidates = fetch_candidates(item, invoker=default_invoker)
                    if candidates:
                        item.attributes["gl_candidates"] = candidates

        if (result is not None and result.resolved) or gl_row is not None:
            resolved_by_rule = result is not None and result.resolved
            category = result.category if resolved_by_rule else "gl-match"
            tier1_match = _auto_clear_evidence(
                resolved_by_rule=resolved_by_rule,
                rule_match=result.match if result is not None else None,
                gl_evidence=gl_evidence,
                gl_row=gl_row,
            )
            created = cases.open(
                item,
                status=CaseStatus.AUTO_CLEARED,
                tier=1,
                category=category,
                tier1_match=tier1_match,
            )
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
            # Open the case PENDING and STOP. Dispatch is no longer this function's job: the Tier-2
            # map run (infra/modules/tier2-dispatch) collects PENDING cases and investigates them
            # MaxConcurrency at a time.
            #
            # Dispatching from here could not be bounded. This consumer runs one invocation per stream
            # shard, and shard count on a PAY_PER_REQUEST table is exactly what a large intake batch
            # inflates, so a fan-out from here scales with the burst it needs to absorb. Moving the
            # decision to a single admission point is what makes a ceiling possible at all.
            #
            # It also makes PENDING mean something. Until now a case flipped to IN_PROGRESS before any
            # work started, so the queue could not distinguish "waiting" from "the model is thinking".
            created = cases.open(item, status=CaseStatus.PENDING, tier=2)
            results.append(
                {
                    "item_id": item.item_id,
                    "status": "PENDING" if created else "DUPLICATE_SKIPPED",
                    "escalated": bool(created),
                    "reason": reason,
                }
            )
    return {"results": results}
