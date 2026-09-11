"""Tests for the notice model and its DynamoDB accessor."""

from decimal import Decimal

import boto3
import pytest
from boto3.dynamodb.conditions import Key
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
                "extraction_confidence": 0.9,
            }
        )


def test_no_extracted_field_is_a_model_attribute() -> None:
    """The invariant the whole de-promotion bought, asserted so a regression cannot be quiet.

    Passing an extracted name to `Notice` does NOT store it -- pydantic ignores extras -- so a reader
    that reached for `notice.counterparty` would get AttributeError rather than a wrong value. The
    absent-versus-blank distinction still matters, but it is now a property of `idp_sections[].fields`,
    which stores exactly what the extractor emitted.
    """
    for name in ("counterparty", "notice_date", "reference", "amount", "fund"):
        assert name not in Notice.model_fields, f"{name} came back as an attribute"
    notice = _notice(idp_sections=[{"section_id": "1", "fields": {"reference": ""}}])
    assert notice.idp_sections[0]["fields"]["reference"] == ""  # extracted, and genuinely blank


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


SEARCH_TABLE_NAME = "recon-notice-search"


def _make_search_table():
    """Handle on the search-index table `_make_notices_table` created.

    :returns: the boto3 Table resource.
    """
    return boto3.resource("dynamodb", region_name="us-east-1").Table(SEARCH_TABLE_NAME)


def _make_notices_table():
    """Create the moto-mocked recon-notices table with all three GSIs from the Terraform module.

    ``idp-document-index`` is the GSI a later Terraform task creates for the Documents tab (hash
    ``idp_record``, range ``idp_started_at``) -- added here now because every test in this file
    builds its table through this helper, and a query test against that index would otherwise fail
    for a reason unrelated to whatever it is actually testing.

    Also creates the notice SEARCH INDEX table, because the two are one Terraform module and the IDP
    hook writes both in the same invocation -- a test that created only the notices table would fail in
    the index write for a reason unrelated to whatever it is asserting. Use `_make_search_table()` to get
    a handle on it.

    :returns: the boto3 Table resource for the notices table, so callers can scan it directly.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=SEARCH_TABLE_NAME,
        KeySchema=[
            {"AttributeName": "search_field", "KeyType": "HASH"},
            {"AttributeName": "search_value", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "search_field", "AttributeType": "S"},
            {"AttributeName": "search_value", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb.create_table(
        TableName="recon-notices",
        KeySchema=[{"AttributeName": "notice_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "notice_id", "AttributeType": "S"},
            {"AttributeName": "counterparty", "AttributeType": "S"},
            {"AttributeName": "notice_date", "AttributeType": "S"},
            {"AttributeName": "reference", "AttributeType": "S"},
            {"AttributeName": "idp_record", "AttributeType": "S"},
            {"AttributeName": "idp_started_at", "AttributeType": "S"},
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
            {
                "IndexName": "idp-document-index",
                "KeySchema": [
                    {"AttributeName": "idp_record", "KeyType": "HASH"},
                    {"AttributeName": "idp_started_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@mock_aws
def test_put_stores_and_get_round_trips() -> None:
    """A stored notice round-trips its index keys and its embedded extraction."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(
        notice=_notice(
            idp_sections=[
                {
                    "section_id": "1",
                    "fields": {
                        "reference": "WIRE-20260302-EVG",
                        "fund": "Direct Lending Fund I",
                        "amount": "2052425.70",
                    },
                }
            ],
        )
    )
    fetched = store.get(notice_id="NTC-0001")
    assert fetched.idp_sections[0]["fields"]["reference"] == "WIRE-20260302-EVG"
    assert fetched.idp_sections[0]["fields"]["fund"] == "Direct Lending Fund I"
    assert fetched.idp_sections[0]["fields"]["amount"] == "2052425.70"


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
    # `subscription_status` is the feed's reference data, never set on the document path.
    assert "subscription_status" not in raw
    assert "confidence_alert_count" in raw


# --- The CUJ's canonical fields --------------------------------------------------------------------

# Recon's own bookkeeping attributes, with a value of the right type. Parametrised rather than asserted
# one by one so adding one to the model without adding it here fails, instead of shipping a field nothing
# has ever round-tripped through DynamoDB.
#
# No EXTRACTED field appears here, and none may be added: extracted content is not a model attribute, so
# there is nothing for `getattr` to round-trip. `idp_sections` is what carries it, covered by
# `test_put_stores_and_get_round_trips` above and by
# `test_removed_promotions_survive_in_idp_sections` in tests/idp_hook/test_mapper_notice.py.
CANONICAL_FIELDS: dict[str, object] = {
    "source_system": "OTHER",
    "parse_method": "IDP",
    "subscription_status": "",
    "source_status_raw": "",
}
# ⚠️ Do NOT add an extracted field name to this dict. These tests round-trip a MODEL ATTRIBUTE, and an
# extracted field does not have one -- `idp_sections` carries it. That path is covered by
# `test_put_stores_and_get_round_trips` above and by
# `test_extracted_fields_survive_in_idp_sections` in tests/idp_hook/test_mapper_notice.py.


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
    """Owner decision: no validation status, no reviewer, and therefore no HIGH band.

    Asserted rather than trusted, because adding one is a one-line change that reads as an
    improvement — and it would silently make the HIGH band reachable.
    """
    forbidden = sorted(
        name for name in Notice.model_fields if "validation" in name or name.startswith("reviewed_")
    )
    assert not forbidden, f"Notice grew a human-validation field: {forbidden}"


def test_the_model_has_no_home_for_a_facility_wide_total() -> None:
    """AM1, restated for a model that no longer stores the total: `amount` is the share or nothing.

    Neither the share nor the facility-wide total is a model attribute, so there is no field either could
    be written to and no attribute a reader could grab in place of the other. The failure this guards is
    someone "helpfully" promoting a total under a name that a share lookup falls back to, which turns a
    visibly-absent fund amount into a plausible wrong one.
    """
    assert "global_amount" not in Notice.model_fields
    assert "amount" not in Notice.model_fields


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
    assert fetched.notice_class == "wire_confirmation"
    assert fetched.idp_sections == []  # the model's default, with the reason beside it
    assert fetched.idp_sections_omitted is not None


# --- IDP tracking snapshot, and the new idp-document-index GSI it feeds ----------------------------


def _tracking_snapshot(**overrides: object) -> dict:
    """Build a minimal ``build_tracking_snapshot``-shaped dict, overriding named keys.

    :param overrides: key values to replace in the baseline snapshot.
    :returns: a plain dict in the shape ``backend/idp_hook/tracking.build_tracking_snapshot``
        returns.
    """
    base: dict[str, object] = {
        "object_status": "SUCCEEDED",
        "workflow_status": "SUCCEEDED",
        "initial_event_time": "2026-03-01T12:00:00+00:00",
        "completion_time": "2026-03-01T12:05:00+00:00",
        "page_count": 3,
        "snapshot_at": "2026-03-01T12:05:01+00:00",
        "sections_meta": [],
    }
    base.update(overrides)
    return base


def _document_record(**overrides: object) -> dict:
    """Build a valid ``put_document_record`` payload, overriding named keys.

    :param overrides: key values to replace in the baseline record.
    :returns: a plain dict with ``notice_id``, ``record_kind`` and a usable ``idp_tracking``
        snapshot. Deliberately does NOT include ``idp_record``/``idp_started_at``:
        ``put_document_record`` derives both from ``idp_tracking``, and a fixture that also
        supplied its own copy could mask a derivation bug -- see
        ``test_put_document_record_derives_idp_started_at_from_the_snapshot`` below, which
        supplies a deliberately WRONG copy to prove derivation wins.
    """
    base: dict[str, object] = {
        "notice_id": "idp-inbox/2026/03/01/wire-0007.pdf",
        "record_kind": "document",
        "idp_tracking": _tracking_snapshot(object_status="FAILED", workflow_status="FAILED"),
        "notice_failure_reason": "IDP execution FAILED before a notice could be extracted",
    }
    base.update(overrides)
    return base


@mock_aws
def test_put_with_a_snapshot_sets_the_gsi_key_attributes() -> None:
    """A snapshot with a start time promotes both idp_record and idp_started_at to top level."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice(idp_tracking=_tracking_snapshot()))
    raw = store.raw(notice_id="NTC-0001")
    assert raw["idp_record"] == "document"
    assert raw["idp_started_at"] == "2026-03-01T12:00:00+00:00"


@mock_aws
def test_put_with_no_snapshot_sets_neither_gsi_key_attribute() -> None:
    """No snapshot at all means the row correctly stays out of the new index."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(notice=_notice())
    raw = store.raw(notice_id="NTC-0001")
    assert "idp_record" not in raw
    assert "idp_started_at" not in raw


@mock_aws
def test_put_with_a_snapshot_missing_initial_event_time_sets_neither_gsi_key_attribute() -> None:
    """Half a GSI key is not stored either -- see put()'s comment on why this is deliberate."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    snapshot = _tracking_snapshot()
    del snapshot["initial_event_time"]
    store.put(notice=_notice(idp_tracking=snapshot))
    raw = store.raw(notice_id="NTC-0001")
    assert "idp_record" not in raw
    assert "idp_started_at" not in raw


@mock_aws
def test_put_document_record_round_trips() -> None:
    """A tracking-only row is readable via raw() and carries no Notice-only fields."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put_document_record(record=_document_record())
    raw = store.raw(notice_id="idp-inbox/2026/03/01/wire-0007.pdf")
    assert raw["record_kind"] == "document"
    assert raw["idp_record"] == "document"
    assert raw["idp_started_at"] == "2026-03-01T12:00:00+00:00"
    assert raw["notice_failure_reason"] == "IDP execution FAILED before a notice could be extracted"


@pytest.mark.parametrize("missing_key", ["notice_id", "record_kind"])
# "   " (whitespace-only) pins the validator's `.strip()` call specifically: `""` alone is already
# falsy without stripping, so a future edit that weakened the check to `not value` and dropped
# `.strip()` would still pass every case here if this one were missing.
@pytest.mark.parametrize("bad_value", [None, "", "   "])
@mock_aws
def test_put_document_record_rejects_a_blank_notice_id_or_record_kind(
    missing_key: str, bad_value: object
) -> None:
    """`notice_id` and `record_kind` must be caught by name, never defaulted."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    record = _document_record()
    record[missing_key] = bad_value
    with pytest.raises(ValueError, match=missing_key):
        store.put_document_record(record=record)


@pytest.mark.parametrize("missing_key", ["notice_id", "record_kind"])
@mock_aws
def test_put_document_record_rejects_an_absent_notice_id_or_record_kind(missing_key: str) -> None:
    """Deleting the key outright must also be caught by name."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    record = _document_record()
    del record[missing_key]
    with pytest.raises(ValueError, match=missing_key):
        store.put_document_record(record=record)


@mock_aws
def test_put_document_record_rejects_a_falsy_non_string_record_kind() -> None:
    """`0`/`False` are falsy but not blank strings -- the equality check must catch them too.

    This is the hole a mere blank check (``isinstance(value, str) and not value.strip()``) would
    miss: `isinstance` is False for a non-string, so a falsy-but-non-string value would sail
    through it. `record_kind` gets no backstop from DynamoDB's own string-typed key attributes the
    way `notice_id` does, so this has to be caught here.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    for bad_value in (0, False):
        record = _document_record(record_kind=bad_value)
        with pytest.raises(ValueError, match="record_kind"):
            store.put_document_record(record=record)


@mock_aws
def test_put_document_record_rejects_a_record_kind_that_is_not_document() -> None:
    """A typo'd or wrong-value record_kind (e.g. "notice") must be rejected outright.

    Letting it through would corrupt the row this method is meant to write with a value the
    ConditionExpression's `:doc` literal can never match again -- see the comment at the check
    this test exercises for the exact failure mode that would follow.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    record = _document_record(record_kind="notice")
    with pytest.raises(ValueError, match="record_kind"):
        store.put_document_record(record=record)


@mock_aws
def test_put_document_record_rejects_a_missing_idp_tracking() -> None:
    """No snapshot at all leaves nothing to derive the GSI key attributes from."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    record = _document_record()
    del record["idp_tracking"]
    with pytest.raises(ValueError, match="idp_tracking"):
        store.put_document_record(record=record)


@mock_aws
def test_put_document_record_rejects_an_idp_tracking_with_no_initial_event_time() -> None:
    """A snapshot missing the one field the GSI's range key comes from is just as unusable."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    snapshot = _tracking_snapshot()
    del snapshot["initial_event_time"]
    record = _document_record(idp_tracking=snapshot)
    with pytest.raises(ValueError, match="idp_tracking"):
        store.put_document_record(record=record)


@mock_aws
def test_put_document_record_derives_idp_started_at_from_the_snapshot() -> None:
    """The GSI's range key must come FROM idp_tracking, never from an independently-supplied copy.

    This is the test that would have caught a Task 4 bug computing `idp_started_at` from
    failure-detection time instead of ingestion-start time: a caller-supplied `idp_started_at` that
    disagrees with the snapshot is deliberately supplied here and must be IGNORED.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    record = _document_record(
        idp_tracking=_tracking_snapshot(initial_event_time="2026-03-01T09:30:00+00:00"),
    )
    record["idp_record"] = "document"
    record["idp_started_at"] = "1999-01-01T00:00:00+00:00"  # wrong on purpose; must be overwritten
    store.put_document_record(record=record)
    raw = store.raw(notice_id=record["notice_id"])
    assert raw["idp_started_at"] == "2026-03-01T09:30:00+00:00"
    assert raw["idp_record"] == "document"


@mock_aws
def test_put_over_an_existing_tracking_row_leaves_exactly_one_notice_item() -> None:
    """The duplicate-row guard: a successful reprocess overwrites its own FAILED tracking row."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    notice_id = "idp-inbox/2026/03/01/wire-0007.pdf"
    store.put_document_record(record=_document_record(notice_id=notice_id))

    store.put(notice=_notice(notice_id=notice_id))

    table = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-notices")
    items = table.scan()["Items"]
    assert len(items) == 1
    assert items[0]["record_kind"] == "notice"
    assert "notice_failure_reason" not in items[0]


@mock_aws
def test_put_document_record_over_an_existing_notice_is_a_no_op() -> None:
    """A reprocess FAILURE must never clobber a good notice already written for this id."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    notice_id = "idp-inbox/2026/03/01/wire-0007.pdf"
    store.put(
        notice=_notice(
            notice_id=notice_id,
            idp_sections=[{"section_id": "1", "fields": {"reference": "WIRE-KEEP-ME"}}],
        )
    )

    # Must not raise, and must not change the stored notice.
    store.put_document_record(record=_document_record(notice_id=notice_id))

    fetched = store.get(notice_id=notice_id)
    assert fetched.idp_sections[0]["fields"]["reference"] == "WIRE-KEEP-ME"
    assert fetched.record_kind == "notice"


@mock_aws
def test_a_document_row_is_queryable_on_the_new_index_and_absent_from_counterparty_index() -> None:
    """The GSI is what lets the tab list documents by ingest time; a tracking row has no counterparty."""
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put_document_record(record=_document_record())

    table = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-notices")
    by_index = table.query(
        IndexName="idp-document-index",
        KeyConditionExpression=Key("idp_record").eq("document"),
    )["Items"]
    assert len(by_index) == 1
    assert by_index[0]["notice_id"] == "idp-inbox/2026/03/01/wire-0007.pdf"

    by_counterparty = table.scan(IndexName="counterparty-index")["Items"]
    assert by_counterparty == []
