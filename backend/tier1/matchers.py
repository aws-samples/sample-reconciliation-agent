"""Deterministic matcher primitives for the Tier-1 engine. Pure comparisons, no LLM."""

from decimal import Decimal


def tolerance_match(a: Decimal, b: Decimal, *, tolerance: Decimal) -> bool:
    """Do two amounts agree within a tolerance band?

    The band is inclusive, so a difference exactly equal to the tolerance counts as a match.

    :param a: the first amount.
    :param b: the second amount.
    :param tolerance: the largest difference still considered a match.
    :returns: True when the amounts agree.
    """
    return abs(a - b) <= tolerance
