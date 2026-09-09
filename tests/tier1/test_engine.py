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


def test_resolved_result_records_the_comparison_it_made():
    """An auto-clear has to be explainable, so the engine keeps the values it compared.

    Recording only ``resolved`` and ``category`` is what left auto-cleared cases with nothing to
    show a human: by the time the case row was written, the rule, the two amounts and the margin had
    all been discarded.
    """
    item = ReconItem(
        item_id="i-9",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "100.00"}),
            ReconSide(name="ledger", attributes={"amount": "100.02"}),
        ],
    )
    result = reconcile(item, rules=RULES)
    assert result.match == {
        "rule_domain": "cash",
        "match_attr": "amount",
        "tolerance": "0.05",
        "side_a_name": "bank",
        "side_b_name": "ledger",
        "side_a_value": "100.00",
        "side_b_value": "100.02",
        "difference": "0.02",
    }


def test_difference_is_exact_not_a_float_approximation():
    """The margin is Decimal arithmetic all the way through.

    ``100.02 - 100.00`` in floats is ``0.020000000000000018``, which reads to an operator as a
    precision problem in the reconciliation rather than in the display.
    """
    item = ReconItem(
        item_id="i-10",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "100.00"}),
            ReconSide(name="ledger", attributes={"amount": "100.02"}),
        ],
    )
    assert reconcile(item, rules=RULES).match["difference"] == "0.02"


def test_exact_match_reports_a_zero_difference_not_a_missing_one():
    """Zero margin and no measurement must not look alike to the case screen."""
    item = ReconItem(
        item_id="i-11",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "250.00"}),
            ReconSide(name="ledger", attributes={"amount": "250.00"}),
        ],
    )
    match = reconcile(item, rules=RULES).match
    assert match is not None
    assert match["difference"] == "0.00"


def test_the_parsed_value_is_reported_not_the_raw_string():
    """What is shown must be what the arithmetic used.

    A side may carry padding or thousands separators that Decimal tolerates; echoing the raw string
    would describe a comparison the engine did not perform.
    """
    item = ReconItem(
        item_id="i-12",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": " 100.00 "}),
            ReconSide(name="ledger", attributes={"amount": "100.00"}),
        ],
    )
    match = reconcile(item, rules=RULES).match
    assert match is not None
    assert match["side_a_value"] == "100.00"


def test_every_escalation_path_leaves_no_match_evidence():
    """``match`` is the mirror of ``category``: present only when the item actually cleared."""
    unresolved = [
        ReconItem(item_id="e-1", domain="unknown", sides=[]),
        ReconItem(
            item_id="e-2",
            domain="cash",
            sides=[ReconSide(name="bank", attributes={"amount": "1.00"})],
        ),
        ReconItem(
            item_id="e-3",
            domain="cash",
            sides=[
                ReconSide(name="bank", attributes={}),
                ReconSide(name="ledger", attributes={"amount": "1.00"}),
            ],
        ),
        ReconItem(
            item_id="e-4",
            domain="cash",
            sides=[
                ReconSide(name="bank", attributes={"amount": "n/a"}),
                ReconSide(name="ledger", attributes={"amount": "1.00"}),
            ],
        ),
        ReconItem(
            item_id="e-5",
            domain="cash",
            sides=[
                ReconSide(name="bank", attributes={"amount": "1.00"}),
                ReconSide(name="ledger", attributes={"amount": "99.00"}),
            ],
        ),
    ]
    for item in unresolved:
        result = reconcile(item, rules=RULES)
        assert result.resolved is False, item.item_id
        assert result.match is None, item.item_id
