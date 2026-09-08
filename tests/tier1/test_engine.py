"""Tests for the Tier-1 deterministic reconcile engine."""

from backend.recon_core.schema import ReconItem, ReconSide
from backend.tier1.engine import (
    ESCALATION_MISSING_MATCH_ATTR,
    ESCALATION_NO_RULE,
    ESCALATION_SIDE_COUNT,
    ESCALATION_TOLERANCE_MISS,
    ESCALATION_UNPARSEABLE_AMOUNT,
    reconcile,
)

RULES = {"cash": {"match_attr": "amount", "tolerance": "0.05", "category": "amount-match"}}


def test_resolves_when_within_tolerance():
    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "100.00"}),
            ReconSide(name="ledger", attributes={"amount": "100.02"}),
        ],
    )
    result = reconcile(item, rules=RULES)
    assert result.resolved is True
    assert result.category == "amount-match"


def test_escalates_when_out_of_tolerance():
    item = ReconItem(
        item_id="i-2",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "100.00"}),
            ReconSide(name="ledger", attributes={"amount": "105.00"}),
        ],
    )
    result = reconcile(item, rules=RULES)
    assert result.resolved is False
    assert result.category is None


def test_missing_attribute_escalates_without_crashing():
    item = ReconItem(
        item_id="i-3",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger", attributes={"amount": "100.00"})],
    )
    result = reconcile(item, rules=RULES)  # bank side missing "amount"
    assert result.resolved is False


# ---------------------------------------------------------------------------------
# Task 6: every escalation names itself
# ---------------------------------------------------------------------------------


def _item(domain="cash", sides=None):
    """Build a minimal ReconItem for the escalation-reason cases.

    :param domain: the item domain (drives the rule lookup).
    :param sides: the sides to compare; defaults to none at all.
    :returns: the item.
    """
    return ReconItem(item_id="i-x", domain=domain, sides=sides or [])


def test_resolved_result_has_no_escalation_reason():
    result = reconcile(
        _item(
            sides=[
                ReconSide(name="bank", attributes={"amount": "100.00"}),
                ReconSide(name="ledger", attributes={"amount": "100.02"}),
            ]
        ),
        rules=RULES,
    )
    assert result.resolved is True and result.escalation_reason is None


def test_unknown_domain_reports_no_rule():
    result = reconcile(_item(domain="securities"), rules=RULES)
    assert result.escalation_reason == ESCALATION_NO_RULE


def test_wrong_side_count_reports_side_count():
    result = reconcile(_item(sides=[ReconSide(name="bank")]), rules=RULES)
    assert result.escalation_reason == ESCALATION_SIDE_COUNT


def test_missing_match_attribute_is_distinguished_from_unparseable():
    """The two data-quality escalations must not collapse into one code.

    "the side has no amount at all" is an upstream mapping problem; "the amount is the string
    'n/a'" is a source-data problem. The agent's first investigative step differs.
    """
    missing = reconcile(
        _item(sides=[ReconSide(name="bank"), ReconSide(name="gl", attributes={"amount": "1"})]),
        rules=RULES,
    )
    assert missing.escalation_reason == ESCALATION_MISSING_MATCH_ATTR
    bad = reconcile(
        _item(
            sides=[
                ReconSide(name="bank", attributes={"amount": "n/a"}),
                ReconSide(name="gl", attributes={"amount": "1"}),
            ]
        ),
        rules=RULES,
    )
    assert bad.escalation_reason == ESCALATION_UNPARSEABLE_AMOUNT


def test_tolerance_miss_reports_tolerance_miss():
    result = reconcile(
        _item(
            sides=[
                ReconSide(name="bank", attributes={"amount": "100.00"}),
                ReconSide(name="gl", attributes={"amount": "105.00"}),
            ]
        ),
        rules=RULES,
    )
    assert result.escalation_reason == ESCALATION_TOLERANCE_MISS
