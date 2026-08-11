"""Tests for the Tier-1 deterministic reconcile engine."""

from backend.recon_core.schema import ReconItem, ReconSide
from backend.tier1.engine import reconcile

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
