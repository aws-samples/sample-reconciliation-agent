"""Tests for the Tier-1 deterministic break classifier."""

from decimal import Decimal

from backend.recon_core.schema import ReconItem, ReconSide
from backend.tier1.classify import BREAK_TYPE_RULES, break_record, classify_break


def test_side_attributes_win_over_the_item_bag():
    """Upstream break columns are authoritative over the derived/enriched passthrough bag."""
    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[ReconSide(name="ibor", attributes={"Party1LocalMV": "0"})],
        attributes={"Party1LocalMV": "999", "idp_class": "wire"},
    )
    rec = break_record(item)
    assert rec.fields["Party1LocalMV"] == "0"
    assert rec.fields["idp_class"] == "wire"


def test_reserved_fields_are_always_present_and_unshadowable():
    item = ReconItem(
        item_id="i-2",
        domain="cash",
        sides=[ReconSide(name="a", attributes={"domain": "spoofed"})],
    )
    rec = break_record(item)
    assert rec.fields["domain"] == "cash"
    assert rec.fields["item_id"] == "i-2" and rec.fields["side_count"] == 1


def test_conflicting_side_values_drop_the_field_rather_than_pick_one():
    item = ReconItem(
        item_id="i-3",
        domain="cash",
        sides=[
            ReconSide(name="ibor", attributes={"Currency": "USD"}),
            ReconSide(name="custody", attributes={"Currency": "EUR"}),
        ],
    )
    rec = break_record(item)
    assert "Currency" not in rec.fields and rec.dropped == ("Currency",)


def test_identical_side_values_are_kept():
    item = ReconItem(
        item_id="i-4",
        domain="cash",
        sides=[
            ReconSide(name="ibor", attributes={"Currency": "USD"}),
            ReconSide(name="custody", attributes={"Currency": "USD"}),
        ],
    )
    assert break_record(item).fields["Currency"] == "USD" and break_record(item).dropped == ()


def test_nested_bag_values_are_omitted():
    """A rule addresses flat fields, so a dict/list value is not a field."""
    item = ReconItem(
        item_id="i-5", domain="cash", sides=[], attributes={"idp_attributes": {"a": 1}}
    )
    assert "idp_attributes" not in break_record(item).fields


def test_decimal_attributes_survive_the_stream_deserializer():
    """A DynamoDB `N` attribute arrives as Decimal, and MUST still be an addressable field.

    Load-bearing, not defensive: the classifier now runs INSIDE the stream consumer, whose
    ``_new_image`` uses boto3's TypeDeserializer, so every numeric attribute on the item (amounts,
    tolerances, anything intake wrote) reaches this function as Decimal — never int. If Decimal is
    not a scalar here the field silently vanishes from the record and any rule naming it can never
    fire. Deserialize for real rather than passing a hand-written int, because an int passes even
    when the bug is present.
    """
    from boto3.dynamodb.types import TypeDeserializer

    de = TypeDeserializer()
    attrs = {k: de.deserialize(v) for k, v in {"days_past_due": {"N": "0"}}.items()}
    assert isinstance(attrs["days_past_due"], Decimal)  # guards the premise
    item = ReconItem(item_id="i-6", domain="cash", sides=[], attributes=attrs)
    rec = break_record(item)
    assert rec.fields["days_past_due"] == Decimal("0")


# ---------------------------------------------------------------------------------
# The plain-Python break-type rule table
# ---------------------------------------------------------------------------------


def test_a_two_sided_break_is_a_record_match_review():
    """Tier-1's tolerance matcher already failed on this item, so the sides genuinely disagree."""
    item = ReconItem(
        item_id="i-7",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
    )
    assert classify_break(break_record(item).fields) == "record-match-review"


def test_a_sides_less_document_is_a_ledger_status_resolution():
    item = ReconItem(item_id="i-8", domain="cash", sides=[], attributes={"idp_class": "notice"})
    assert classify_break(break_record(item).fields) == "ledger-status-resolution"


def test_an_unrecognised_shape_yields_no_class():
    """No rule resolved it => escalate unclassified, which is the pre-feature behaviour.

    Deliberately fail-open rather than guessing: an unclassified escalation costs the agent one
    classification it was already doing, whereas a wrong class points the investigation at the
    wrong procedure.
    """
    item = ReconItem(item_id="i-9", domain="cash", sides=[ReconSide(name="only-one")])
    assert classify_break(break_record(item).fields) is None


def test_classify_break_does_not_need_any_field_to_be_present():
    """Every rule must be total over the record — a KeyError here would poison the stream shard.

    The classifier runs on a DynamoDB Stream consumer, where an exception is not a failed
    classification but a blocked shard until the record ages out. Rules use ``.get`` for exactly
    this reason; this test fails the moment one stops.
    """
    assert classify_break({}) is None


def test_the_rules_are_mutually_exclusive_on_the_shapes_they_claim():
    """Order is not load-bearing today, and this is what keeps it that way.

    If a new rule overlaps an existing one, this fails and the tie-break has to be made explicit in
    BREAK_TYPE_RULES rather than left to tuple order.
    """
    for side_count in (0, 1, 2, 3):
        matched = [name for name, pred in BREAK_TYPE_RULES if pred({"side_count": side_count})]
        assert len(matched) <= 1, f"{side_count} sides matched {matched}"
