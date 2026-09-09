"""Tier-1 deterministic reconciliation engine. No LLM anywhere in it.

This runs first on every item. It applies the domain's matcher rule and either resolves the item,
which auto-clears it, or signals escalation to the Tier-2 agent. A missing or unparseable match
attribute escalates cleanly instead of crashing, because this code runs inside a DynamoDB Stream
consumer and a crash there poisons the shard for every item behind it.

Every escalation path names itself with one of the ``ESCALATION_*`` codes below. An unnamed escalation
loses information the same way a swallowed exception does: by the time the item reaches the agent,
"the amounts differ" and "the amount was missing" look identical, and they call for completely
different investigations.
"""

from dataclasses import dataclass
from decimal import Decimal

from backend.recon_core.schema import ReconItem
from backend.tier1.matchers import tolerance_match


# Machine-readable escalation reasons. They travel to the agent on the item's
# ``tier1_escalation_reason`` attribute, which makes them a contract rather than log text. Renaming one
# changes what the agent is told. The distinction that matters most: amounts differing is a real
# break, while a missing match attribute is a data-quality problem upstream, and the agent should not
# investigate the second as if it were the first.
ESCALATION_NO_RULE = "no_rule"  # no deterministic rule configured for this domain
ESCALATION_SIDE_COUNT = "side_count"  # not exactly two sides to compare
ESCALATION_MISSING_MATCH_ATTR = "missing_match_attr"  # a side omits the match attribute
ESCALATION_UNPARSEABLE_AMOUNT = "unparseable_amount"  # present but not a number
ESCALATION_TOLERANCE_MISS = "tolerance_miss"  # both parsed, difference exceeds tolerance
ESCALATION_TIER1_DISABLED = "tier1_disabled"  # operator turned the deterministic tier off


@dataclass
class Tier1Result:
    """The outcome of a Tier-1 attempt: resolved with a category, or escalating with a reason.

    ``category`` is the auto-clear reason and is set only when ``resolved`` is True.
    ``escalation_reason`` is its mirror image, set only when ``resolved`` is False. One of the two is
    always populated: an escalation that names no reason is indistinguishable from every other
    escalation by the time the agent sees the item.

    ``match`` accompanies ``category`` and records the comparison that actually cleared the item —
    which attribute was compared, on which two sides, at what values, and by what margin. Without it
    an auto-cleared case can state only that it cleared, never how, and the case screen has nothing
    to show a human asked to trust the deterministic tier. Every value is a string because the
    numbers are ``Decimal``, and a ``Decimal`` neither survives a JSON hop nor should be coerced to
    a float on the way through one.
    """

    resolved: bool
    category: str | None = None
    escalation_reason: str | None = None
    match: dict[str, str] | None = None


def reconcile(item: ReconItem, *, rules: dict) -> Tier1Result:
    """Attempt deterministic reconciliation, resolving the item or escalating with a named reason.

    :param item: the reconciliation item.
    :param rules: the rule set keyed by domain, each entry supplying ``match_attr``, ``tolerance`` and
        ``category``.
    :returns: the Tier-1 result. This function does not raise: it runs on a stream shard, where an
        exception blocks every item behind it until the record ages out.
    """
    rule = rules.get(item.domain)
    if rule is None:
        return Tier1Result(resolved=False, escalation_reason=ESCALATION_NO_RULE)
    if len(item.sides) != 2:
        return Tier1Result(resolved=False, escalation_reason=ESCALATION_SIDE_COUNT)
    attr, tol = rule["match_attr"], Decimal(rule["tolerance"])
    try:
        raw_a, raw_b = item.sides[0].attributes[attr], item.sides[1].attributes[attr]
    except KeyError:
        return Tier1Result(resolved=False, escalation_reason=ESCALATION_MISSING_MATCH_ATTR)
    try:
        a, b = Decimal(raw_a), Decimal(raw_b)
    except ArithmeticError:
        # The attribute is there but it is not a number, which is a data-quality problem rather than a
        # reconciliation difference, so it gets its own reason. ArithmeticError is the right class to
        # catch: InvalidOperation, which is what ``Decimal("n/a")`` raises, is a subclass of it.
        return Tier1Result(resolved=False, escalation_reason=ESCALATION_UNPARSEABLE_AMOUNT)
    if tolerance_match(a, b, tolerance=tol):
        # Record the comparison, not just the verdict. The parsed ``a`` and ``b`` are reported rather
        # than ``raw_a`` and ``raw_b``: the parsed values are what the arithmetic used, and a raw
        # string may carry padding or a stray symbol that never entered it, so showing the raw form
        # would describe a comparison that did not happen.
        return Tier1Result(
            resolved=True,
            category=rule["category"],
            match={
                "rule_domain": item.domain,
                "match_attr": attr,
                "tolerance": str(tol),
                "side_a_name": item.sides[0].name,
                "side_b_name": item.sides[1].name,
                "side_a_value": str(a),
                "side_b_value": str(b),
                "difference": str(abs(a - b)),
            },
        )
    return Tier1Result(resolved=False, escalation_reason=ESCALATION_TOLERANCE_MISS)
