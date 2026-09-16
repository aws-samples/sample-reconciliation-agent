"""Tests for the search_notices query planner (no AWS calls).

It no longer plans an ACCESS PATH -- candidates come from the notice search index, resolved by no
particular field name. What is planned here is bounds, filters, the exact-match set and the row cap.
"""

from decimal import Decimal

import pytest

from backend.notice_tool.handler import plan_query


def test_every_named_hint_becomes_an_ordinary_filter() -> None:
    """No access path is chosen here any more, and no field name is privileged.

    `reference` and `counterparty` used to win a GSI key condition; they are plain equality filters now,
    resolved through the search index like anything else the caller sends.
    """
    plan = plan_query(
        reference="WIRE-20260302-EVG",
        counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
        fund="Direct Lending Fund I",
        activity_type="Interest",
        notice_class="wire_confirmation",
    )
    assert plan.filtered_fields == {
        "reference": "WIRE-20260302-EVG",
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "fund": "Direct Lending Fund I",
        "activity_type": "Interest",
        "notice_class": "wire_confirmation",
    }


def test_no_hints_is_an_unconstrained_plan() -> None:
    """Every notice is a candidate, and `handle` caps the fetch. There is no scan flag to set."""
    plan = plan_query()
    assert plan.filtered_fields == {}
    assert plan.required_fields == frozenset()
    assert plan.amount_low is None


def test_dates_stay_bounds_rather_than_becoming_a_key_condition() -> None:
    """The window constrains the result wherever it came from; no index is involved in deciding that."""
    plan = plan_query(counterparty="X", date_from="2026-03-01", date_to="2026-03-31")
    assert (plan.date_from, plan.date_to) == ("2026-03-01", "2026-03-31")
    assert plan_query(reference="W1", date_from="2026-03-01").date_from == "2026-03-01"


def test_require_is_parsed_into_the_fields_to_match_exactly() -> None:
    """The caller names them, which is what keeps the exact-match set out of this module.

    Whitespace tolerated and blanks dropped, because the model composes this string.
    """
    assert plan_query(require="reference").required_fields == frozenset({"reference"})
    assert plan_query(require=" reference , cusip ,, ").required_fields == frozenset(
        {"reference", "cusip"}
    )
    assert plan_query().required_fields == frozenset()


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


def test_activity_type_is_an_ordinary_filter() -> None:
    """Class-dependent, so it is a filter and its absence is annotated rather than excluding a row."""
    plan = plan_query(counterparty="MISTFELL FOODS CORP.", activity_type="Commitment Fee")
    assert plan.filtered_fields["activity_type"] == "Commitment Fee"
    assert "activity_type" not in plan.required_fields
