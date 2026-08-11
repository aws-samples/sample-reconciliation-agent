"""Tier-1 deterministic reconciliation engine (no LLM).

Runs first on every ReconItem. Applies the domain's matcher rule and either resolves the
item (auto-clear) or signals escalation to the Tier-2 agent. Missing or unparseable match
attributes escalate cleanly rather than crashing — a crash inside the DynamoDB-Stream
consumer would poison the shard.
"""

from dataclasses import dataclass
from decimal import Decimal

from backend.recon_core.schema import ReconItem
from backend.tier1.matchers import tolerance_match


@dataclass
class Tier1Result:
    """Outcome of a Tier-1 attempt: resolved (with a category) or escalate."""

    resolved: bool
    category: str | None = None


def reconcile(item: ReconItem, *, rules: dict) -> Tier1Result:
    """Attempt deterministic reconciliation. No LLM. Resolve or escalate."""
    rule = rules.get(item.domain)
    if rule is None or len(item.sides) != 2:
        return Tier1Result(resolved=False)
    attr, tol = rule["match_attr"], Decimal(rule["tolerance"])
    try:
        a = Decimal(item.sides[0].attributes[attr])
        b = Decimal(item.sides[1].attributes[attr])
    except (KeyError, ArithmeticError):
        # missing/unparseable match attribute -> escalate cleanly, never crash
        return Tier1Result(resolved=False)
    if tolerance_match(a, b, tolerance=tol):
        return Tier1Result(resolved=True, category=rule["category"])
    return Tier1Result(resolved=False)
