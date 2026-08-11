"""Generic deterministic matcher primitives for the Tier-1 engine (no LLM)."""

from decimal import Decimal


def tolerance_match(a: Decimal, b: Decimal, *, tolerance: Decimal) -> bool:
    """Return True if abs(a - b) is within an inclusive tolerance band."""
    return abs(a - b) <= tolerance
