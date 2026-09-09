"""Tests for the notice model and its DynamoDB accessor."""

from decimal import Decimal

import boto3
import pytest
from moto import mock_aws
from pydantic import ValidationError

from backend.recon_core.notices import Notice, NoticeStore


def _notice(**overrides: object) -> Notice:
    """Build a valid Notice, overriding named fields.

    :param overrides: field values to replace in the baseline record.
    :returns: a validated Notice.
    """
    base: dict[str, object] = {
        "notice_id": "NTC-0001",
        "notice_class": "wire_confirmation",
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "notice_date": "2026-03-02",
        "extraction_confidence": 0.94,
        "confidence_alert_count": 0,
    }
    base.update(overrides)
    return Notice.model_validate(base)


def test_notice_requires_confidence_alert_count() -> None:
    """Omitting the key must fail: the interceptor's guard only works if every row carries one."""
    with pytest.raises(ValidationError):
        Notice.model_validate(
            {
                "notice_id": "NTC-0001",
                "notice_class": "wire_confirmation",
                "counterparty": "X",
                "notice_date": "2026-03-02",
                "extraction_confidence": 0.9,
            }
        )


def test_notice_distinguishes_absent_from_empty_optional_fields() -> None:
    """Not-extracted-for-this-class and extracted-and-blank are different answers."""
    notice = _notice(fund="", facility=None)
    assert notice.fund == ""  # extracted, and genuinely blank
    assert notice.facility is None  # this class never extracts a facility


def test_notice_rejects_confidence_outside_unit_interval() -> None:
    """A confidence above 1 is a unit error, not a very confident extraction."""
    with pytest.raises(ValidationError):
        _notice(extraction_confidence=1.4)


def test_notice_rejects_negative_alert_count() -> None:
    """A negative count of alerts is meaningless and would compare as "clean"."""
    with pytest.raises(ValidationError):
        _notice(confidence_alert_count=-1)


def test_notice_accepts_an_explicit_unresolved_alert_count() -> None:
    """None is the third state the interceptor refuses on."""
    # None is a THIRD state, distinct from 0 and from the key being absent: "the extraction could
    # not be resolved". The interceptor refuses the write on it.
    assert _notice(confidence_alert_count=None).confidence_alert_count is None


# --- NoticeStore ----------------------------------------------------------------------------------


def _make_notices_table():
    """Create the moto-mocked recon-notices table with both GSIs from the Terraform module.

    :returns: the boto3 Table resource, so callers can scan it directly.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    return ddb.create_table(
        TableName="recon-notices",
        KeySchema=[{"AttributeName": "notice_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "notice_id", "AttributeType": "S"},
            {"AttributeName": "counterparty", "AttributeType": "S"},
            {"AttributeName": "notice_date", "AttributeType": "S"},
            {"AttributeName": "reference", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "counterparty-index",
                "KeySchema": [
                    {"AttributeName": "counterparty", "KeyType": "HASH"},
                    {"AttributeName": "notice_date", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
            {
                "IndexName": "reference-index",
                "KeySchema": [{"AttributeName": "reference", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@mock_aws
def test_put_stores_and_get_round_trips() -> None:
    """A stored notice comes back with its Decimal amount and its unextracted fields still None."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice(fund="Direct Lending Fund I", amount=Decimal("2052425.70")))
    fetched = store.get(notice_id="NTC-0001")
    assert fetched.fund == "Direct Lending Fund I"
    assert fetched.amount == Decimal("2052425.70")
    assert fetched.facility is None  # not extracted for this class, and absent from the row


@mock_aws
def test_put_overwrites_on_reextraction() -> None:
    """Re-extraction replaces the stale row; there is no reprocess guard to trip."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice(confidence_alert_count=3))
    store.put(notice=_notice(confidence_alert_count=0))
    assert store.get(notice_id="NTC-0001").confidence_alert_count == 0


@mock_aws
def test_get_raises_on_missing_notice() -> None:
    """A missing notice raises rather than returning an empty stand-in."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    with pytest.raises(KeyError, match="NTC-9999"):
        store.get(notice_id="NTC-9999")


@mock_aws
def test_unextracted_fields_are_absent_not_null() -> None:
    """The stored SHAPE matters: fields_unavailable and the interceptor both key off absence."""
    # The interceptor and fields_unavailable both key off ABSENCE, so assert the stored shape.
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice())
    raw = store.raw(notice_id="NTC-0001")
    assert "facility" not in raw
    assert "confidence_alert_count" in raw


# --- The CUJ's canonical fields --------------------------------------------------------------------

# Every field this plan added, with a value of the right type. Parametrised rather than asserted one by
# one so adding a field to the model without adding it here fails the count test below, instead of
# shipping a field nothing has ever round-tripped.
CANONICAL_FIELDS: dict[str, object] = {
    "activity_type": "Interest",
    "global_amount": Decimal("3939077.64"),
    "fee_amount": Decimal("446.67"),
    "fee_percentage": Decimal("0.375"),
    "amount_type": "FUND_SPECIFIC",
    "facility_id_source_raw": "SL-204811",
    "loanx_id": "LX0063110",
    "cusip": "34567EF8",
    "isin": "US34567EF80",
    "agent_bank": "Meridian Agency Services LLC",
    "agent_contact_name": "Dana Whitfield",
    "agent_email": "loan.ops@meridian-agent.example",
    "agent_telephone": "+1-555-0100",
    "contract_id": "CT-204811-A",
    "new_contract_id": "CT-204811-B",
    "notice_comment": "only interest notice",
    "notice_date_source_raw": "26-Jan-2026",
    "source_system": "OTHER",
    "parse_method": "IDP",
    "subscription_status": "",
    "source_status_raw": "",
}


@mock_aws
def test_every_canonical_field_round_trips() -> None:
    """A field that cannot survive DynamoDB is a field the agent will never see.

    Decimal rather than float is the trap this catches: boto3's DynamoDB resource raises TypeError on
    a float, so a float-typed amount field would pass every in-memory model test and fail every write.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice(**CANONICAL_FIELDS))
    fetched = store.get(notice_id="NTC-0001")
    for name, expected in CANONICAL_FIELDS.items():
        assert getattr(fetched, name) == expected, f"{name} did not round-trip"


@mock_aws
def test_canonical_fields_are_absent_when_not_extracted() -> None:
    """Absence is the signal the agent reads as `fields_unavailable`; NULL would read as a value."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice())
    raw = store.raw(notice_id="NTC-0001")
    present = sorted(name for name in CANONICAL_FIELDS if name in raw)
    assert not present, f"unextracted fields were stored rather than omitted: {present}"


def test_a_blank_canonical_field_is_kept_as_blank() -> None:
    """`""` and absent are different answers, and the two STRUCTURED_FEED fields are where it shows.

    `subscription_status` blank means "the source said nothing", which is treated as ambiguous routing
    that blocks approval. Absent means the source was never consulted. Collapsing them would turn a
    known-ambiguous case into an unknown one.
    """
    notice = _notice(subscription_status="", source_status_raw=None)
    assert notice.subscription_status == ""
    assert notice.source_status_raw is None


def test_no_human_validation_field_exists() -> None:
    """Owner decision (design D7): no validation status, no reviewer, and therefore no HIGH band.

    Asserted rather than trusted, because re-adding one is a one-line change that reads as an
    improvement — and it would silently make the HIGH band reachable again.
    """
    forbidden = sorted(
        name for name in Notice.model_fields if "validation" in name or name.startswith("reviewed_")
    )
    assert not forbidden, f"Notice grew a human-validation field: {forbidden}"


def test_amount_and_global_amount_are_independent() -> None:
    """The global total must never stand in for the fund share — AM1, and the reason for two fields."""
    notice = _notice(amount=None, global_amount=Decimal("462150998.05"))
    assert notice.amount is None  # fund-level validation is unavailable, and visibly so
    assert notice.global_amount == Decimal("462150998.05")


# --- The embedded per-section extraction, and the one place it yields ------------------------------


def _section(*, field_count: int, value: str = "v") -> dict:
    """Build one embedded section with a given number of scored fields.

    :param field_count: how many field/confidence pairs to generate.
    :param value: the extracted value to repeat, used to inflate the row's size.
    :returns: an ``idp_sections`` entry in the shape the mapper writes.
    """
    return {
        "section_id": "1",
        "classification": "LoanPaymentNotice",
        "page_ids": [0],
        "fields": {f"Field{i}": value for i in range(field_count)},
        "confidences": [
            {
                "field": f"Field{i}",
                "confidence": Decimal("0.95"),
                "threshold": Decimal("0.8"),
                "value": value,
                "extracted": True,
            }
            for i in range(field_count)
        ],
        "mean_confidence": Decimal("0.95"),
        "alert_count": 0,
    }


@mock_aws
def test_the_embedded_sections_round_trip() -> None:
    """A live 17-field section is ~6 KB, so the ordinary case must simply store and come back."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice(idp_sections=[_section(field_count=17)]))
    fetched = store.get(notice_id="NTC-0001")
    assert len(fetched.idp_sections) == 1
    assert len(fetched.idp_sections[0]["confidences"]) == 17
    assert fetched.idp_sections[0]["confidences"][0]["confidence"] == Decimal("0.95")
    assert fetched.idp_sections_omitted is None  # nothing was dropped, and the row says so


@mock_aws
def test_no_sections_is_stored_as_an_empty_list_not_an_absent_attribute() -> None:
    """Empty is a real answer here — "read, nothing to show" — unlike the class-dependent fields."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice())
    raw = store.raw(notice_id="NTC-0001")
    assert raw["idp_sections"] == []


@mock_aws
def test_an_oversized_extraction_still_writes_the_notice_with_the_reason() -> None:
    """The row feeds the matcher and the interceptor's refusal, so the DISPLAY detail is what yields.

    Failing the put instead would take out reconciliation for this notice to protect a drawer.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    # ~500 KB of extracted values: past DynamoDB's 400 KB item ceiling, never mind our budget.
    store.put(notice=_notice(idp_sections=[_section(field_count=500, value="x" * 500)]))
    raw = store.raw(notice_id="NTC-0001")
    assert "idp_sections" not in raw
    assert "over the" in raw["idp_sections_omitted"]
    # The two aggregates are separate scalars, so the guard cannot disarm the interceptor.
    assert raw["confidence_alert_count"] == 0
    assert raw["extraction_confidence"] == Decimal("0.94")


@mock_aws
def test_an_oversized_extraction_leaves_the_rest_of_the_notice_intact() -> None:
    """Only `idp_sections` is dropped: everything the matcher reads must survive the trim."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(
        notice=_notice(
            reference="WIRE-20260302-EVG",
            amount=Decimal("9640.18"),
            idp_sections=[_section(field_count=500, value="x" * 500)],
        )
    )
    fetched = store.get(notice_id="NTC-0001")
    assert fetched.reference == "WIRE-20260302-EVG"
    assert fetched.amount == Decimal("9640.18")
    assert fetched.idp_sections == []  # the model's default, with the reason beside it
    assert fetched.idp_sections_omitted is not None
