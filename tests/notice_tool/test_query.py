"""Tests for the search_notices access-path planner (no AWS calls)."""

from decimal import Decimal

import pytest

from backend.notice_tool.handler import plan_query


def test_reference_hint_uses_the_reference_index() -> None:
    """The most selective hint wins the key condition."""
    plan = plan_query(reference="WIRE-20260302-EVG")
    assert plan.index_name == "reference-index"
    assert plan.is_scan is False


def test_counterparty_hint_uses_the_counterparty_index() -> None:
    """Counterparty is exact, so it is a key condition rather than a filter."""
    plan = plan_query(counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.")
    assert plan.index_name == "counterparty-index"


def test_reference_wins_over_counterparty_as_the_more_selective_hint() -> None:
    """When both are given the loser must still constrain the result set."""
    plan = plan_query(reference="WIRE-1", counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.")
    assert plan.index_name == "reference-index"
    # The unused hint must not be dropped — it becomes a filter, or it silently stops mattering.
    assert "counterparty" in plan.filtered_fields


def test_dates_become_a_range_condition_only_on_the_counterparty_index() -> None:
    """notice_date is that index's range key; elsewhere it can only be a filter."""
    plan = plan_query(counterparty="X", date_from="2026-03-01", date_to="2026-03-31")
    assert plan.has_date_range is True
    scan_plan = plan_query(reference="WIRE-1", date_from="2026-03-01", date_to="2026-03-31")
    assert scan_plan.has_date_range is False
    assert "notice_date" in scan_plan.filtered_fields


def test_no_hints_falls_back_to_a_marked_scan() -> None:
    """A Scan is allowed but must be visible, so handle() can cap it and report truncation."""
    plan = plan_query()
    assert plan.is_scan is True
    assert plan.index_name is None


def test_amount_becomes_an_inclusive_band() -> None:
    """Tolerance matching is a band around the centre, computed in Decimal."""
    plan = plan_query(amount="1000.00", amount_tolerance="0.50")
    assert plan.amount_low == Decimal("999.50")
    assert plan.amount_high == Decimal("1000.50")


def test_amount_tolerance_without_amount_is_an_error_not_a_no_op() -> None:
    """A tolerance with nothing to centre on means the caller misunderstood the parameters."""
    with pytest.raises(ValueError, match="amount_tolerance"):
        plan_query(amount_tolerance="0.50")


def test_non_numeric_amount_raises_rather_than_matching_everything() -> None:
    """Ignoring an unparseable amount would widen the search to every notice."""
    with pytest.raises(ValueError, match="amount"):
        plan_query(amount="about a million")


def test_limit_is_capped_not_silently_honoured() -> None:
    """The cap is clamped at both ends, so a model cannot request a table dump or zero rows."""
    assert plan_query(limit=999).limit == 100
    assert plan_query(limit=0).limit == 1


def test_activity_type_is_a_filter_never_a_key_condition() -> None:
    """There is no GSI on activity_type, so it can only ever narrow a set the keys already chose."""
    plan = plan_query(counterparty="MISTFELL FOODS CORP.", activity_type="Commitment Fee")
    assert plan.key_field == "counterparty"
    assert plan.filtered_fields["activity_type"] == "Commitment Fee"


def test_activity_type_alone_still_scans() -> None:
    """A filter is not selective enough to choose an access path; the scan must be marked as one."""
    plan = plan_query(activity_type="Rollover")
    assert plan.is_scan is True
    assert plan.filtered_fields == {"activity_type": "Rollover"}
