"""Tests for the Tier-1 matcher primitives."""

from decimal import Decimal

from backend.tier1.matchers import tolerance_match


def test_tolerance_band_is_inclusive():
    assert tolerance_match(Decimal("100.00"), Decimal("100.02"), tolerance=Decimal("0.05")) is True
    assert tolerance_match(Decimal("100.00"), Decimal("100.10"), tolerance=Decimal("0.05")) is False
