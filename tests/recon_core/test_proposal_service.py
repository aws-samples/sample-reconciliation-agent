"""Tests for the shared derive_reference rule (one implementation, both backends)."""

from backend.recon_core.proposal_service import derive_reference


def test_exactly_one_distinct_reference_wins():
    assert derive_reference(["DRW-1", "DRW-1", "DRW-1"]) == "DRW-1"


def test_zero_references_is_non_executable():
    assert derive_reference([]) is None


def test_multiple_distinct_references_is_non_executable():
    assert derive_reference(["DRW-1", "DRW-2"]) is None


def test_blank_and_non_string_values_are_ignored():
    assert derive_reference(["", "DRW-1", None]) == "DRW-1"  # type: ignore[list-item]


def test_to_decimal_safe_deep_converts_floats():
    """Raw tool args (e.g. float amount-range searches) must persist to DynamoDB (regression:
    live TypeError 'Float types are not supported' on the first amount-range investigation)."""
    from decimal import Decimal

    from backend.recon_core.proposal_service import to_decimal_safe

    out = to_decimal_safe({"steps": [{"tool_input": {"min_amount": 23.73, "limit": 5}}, "x"]})
    assert out["steps"][0]["tool_input"]["min_amount"] == Decimal("23.73")
    assert out["steps"][0]["tool_input"]["limit"] == 5
    assert out["steps"][1] == "x"
