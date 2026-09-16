"""Tests for scripts/backfill_idp_document_index.py.

Uses `moto` against a table shaped exactly like `_make_notices_table()` in
`tests/recon_core/test_notices.py` -- same three GSIs, including `idp-document-index` (hash
`idp_record`, range `idp_started_at`). The live table this script targets is `recon-dev-notices`,
but the table NAME here is arbitrary (`recon-notices-backfill-test`), same as every other moto
fixture in this repo -- only the deployed name in `--table`'s default matters operationally.
"""

from decimal import Decimal

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from scripts.backfill_idp_document_index import main, plan_update, resolve_idp_started_at

TABLE_NAME = "recon-notices-backfill-test"


def _make_notices_table():
    """Create a moto-mocked notices table with the same three GSIs as the live deployment.

    Mirrors `tests/recon_core/test_notices.py`'s `_make_notices_table()` exactly, since this
    script's whole point is to make rows queryable on `idp-document-index`, and that GSI is what
    the final test in this file queries.

    :returns: the boto3 Table resource.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    return ddb.create_table(
        TableName=TABLE_NAME,
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


def _pre_change_row(**overrides: object) -> dict:
    """A row shaped exactly like what was measured live on recon-dev-notices before this backfill.

    No `record_kind`, no `idp_record`/`idp_started_at`, no `idp_tracking`, `parse_method == "IDP"`.

    :param overrides: attribute values to replace in the baseline row.
    :returns: a plain dict ready for `table.put_item`.
    """
    row: dict[str, object] = {
        "notice_id": "idp-NTC-0001",
        "notice_class": "wire_confirmation",
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "notice_date": "2026-08-31",
        "parse_method": "IDP",
        "amount": Decimal("1000.00"),
    }
    row.update(overrides)
    return row


# --- resolve_idp_started_at / plan_update -----------------------------------------------------


def test_resolve_prefers_idp_tracking_initial_event_time() -> None:
    """A row with a real tracking snapshot uses ITS start time, not an approximation."""
    row = _pre_change_row(idp_tracking={"initial_event_time": "2026-08-10T00:00:00.000Z"})
    started_at, approximate = resolve_idp_started_at(row=row)
    assert started_at == "2026-08-10T00:00:00.000Z"
    assert approximate is False


def test_resolve_falls_back_to_notice_date_normalised_to_a_full_timestamp() -> None:
    """No idp_tracking at all -- the live shape -- normalises the date-only notice_date."""
    row = _pre_change_row(notice_date="2026-08-31")
    started_at, approximate = resolve_idp_started_at(row=row)
    assert started_at == "2026-08-31T00:00:00+00:00"
    assert approximate is True


def test_resolve_raises_with_no_tracking_and_no_notice_date() -> None:
    """Nothing to index by must fail loudly, never fabricate a value with no basis at all."""
    row = {"notice_id": "idp-NTC-9999", "parse_method": "IDP"}
    with pytest.raises(ValueError, match="nothing to index"):
        resolve_idp_started_at(row=row)


def test_plan_update_for_a_pre_change_row() -> None:
    """The exact live shape: absent record_kind, absent idp_record/idp_started_at, parse_method
    IDP.
    """
    row = _pre_change_row()
    updates = plan_update(row=row)
    assert updates == {
        "record_kind": "notice",
        "idp_record": "document",
        "idp_started_at": "2026-08-31T00:00:00+00:00",
        "idp_started_at_approximate": True,
    }


def test_plan_update_uses_idp_tracking_when_present_and_sets_no_approximate_flag() -> None:
    """A row that already carries a real tracking snapshot must not be flagged approximate."""
    row = _pre_change_row(idp_tracking={"initial_event_time": "2026-08-10T00:00:00.000Z"})
    updates = plan_update(row=row)
    assert updates == {
        "record_kind": "notice",
        "idp_record": "document",
        "idp_started_at": "2026-08-10T00:00:00.000Z",
    }
    assert "idp_started_at_approximate" not in updates


def test_plan_update_skips_gsi_keys_for_a_non_idp_parse_method() -> None:
    """parse_method != IDP gets record_kind only -- no GSI keys, no approximate flag, ever."""
    row = _pre_change_row(parse_method="MANUAL")
    updates = plan_update(row=row)
    assert updates == {"record_kind": "notice"}
    assert "idp_record" not in updates
    assert "idp_started_at" not in updates
    assert "idp_started_at_approximate" not in updates


def test_plan_update_is_empty_once_fully_backfilled() -> None:
    """A row already carrying everything needs nothing further -- the idempotency guarantee."""
    row = _pre_change_row(
        record_kind="notice",
        idp_record="document",
        idp_started_at="2026-08-31T00:00:00+00:00",
        idp_started_at_approximate=True,
    )
    assert plan_update(row=row) == {}


# --- main(): dry-run default, --apply, idempotent re-run, and the GSI query -------------------


@mock_aws
def test_dry_run_is_the_default_and_writes_nothing() -> None:
    """Omitting --apply must leave the row byte-for-byte unchanged."""
    table = _make_notices_table()
    table.put_item(Item=_pre_change_row())

    exit_code = main(["--table", TABLE_NAME, "--region", "us-east-1"])

    assert exit_code == 0
    row = table.get_item(Key={"notice_id": "idp-NTC-0001"})["Item"]
    assert "record_kind" not in row
    assert "idp_record" not in row
    assert "idp_started_at" not in row
    assert "idp_started_at_approximate" not in row


@mock_aws
def test_apply_writes_the_backfilled_attributes_via_update_item() -> None:
    """--apply performs the write, and existing non-GSI attributes (e.g. amount) survive it.

    Surviving `amount` is the proof this went through UpdateItem, not PutItem: a PutItem would have
    replaced the whole row and dropped it.
    """
    table = _make_notices_table()
    table.put_item(Item=_pre_change_row())

    exit_code = main(["--table", TABLE_NAME, "--region", "us-east-1", "--apply"])

    assert exit_code == 0
    row = table.get_item(Key={"notice_id": "idp-NTC-0001"})["Item"]
    assert row["record_kind"] == "notice"
    assert row["idp_record"] == "document"
    assert row["idp_started_at"] == "2026-08-31T00:00:00+00:00"
    assert row["idp_started_at_approximate"] is True
    assert row["amount"] == Decimal("1000.00")  # untouched extracted field


@mock_aws
def test_row_with_real_tracking_snapshot_is_not_flagged_approximate() -> None:
    """The GSI's range key comes from idp_tracking when it is present; no approximate flag."""
    table = _make_notices_table()
    table.put_item(
        Item=_pre_change_row(
            notice_id="idp-NTC-0002",
            idp_tracking={"initial_event_time": "2026-08-10T00:00:00.000Z"},
        )
    )

    main(["--table", TABLE_NAME, "--region", "us-east-1", "--apply"])

    row = table.get_item(Key={"notice_id": "idp-NTC-0002"})["Item"]
    assert row["idp_started_at"] == "2026-08-10T00:00:00.000Z"
    assert "idp_started_at_approximate" not in row


@mock_aws
def test_non_idp_row_gets_record_kind_only() -> None:
    """parse_method != IDP: record_kind is set, but no GSI keys and no approximate flag."""
    table = _make_notices_table()
    table.put_item(Item=_pre_change_row(notice_id="idp-NTC-0003", parse_method="MANUAL"))

    main(["--table", TABLE_NAME, "--region", "us-east-1", "--apply"])

    row = table.get_item(Key={"notice_id": "idp-NTC-0003"})["Item"]
    assert row["record_kind"] == "notice"
    assert "idp_record" not in row
    assert "idp_started_at" not in row
    assert "idp_started_at_approximate" not in row


@mock_aws
def test_second_apply_run_is_a_no_op() -> None:
    """Re-running must change nothing and report every row skipped, per the idempotency
    guarantee.
    """
    table = _make_notices_table()
    table.put_item(Item=_pre_change_row())

    main(["--table", TABLE_NAME, "--region", "us-east-1", "--apply"])
    row_after_first = dict(table.get_item(Key={"notice_id": "idp-NTC-0001"})["Item"])

    main(["--table", TABLE_NAME, "--region", "us-east-1", "--apply"])
    row_after_second = dict(table.get_item(Key={"notice_id": "idp-NTC-0001"})["Item"])

    assert row_after_first == row_after_second


@mock_aws
def test_backfilled_row_is_queryable_on_the_idp_document_index() -> None:
    """The point of the whole task: a pre-change row becomes visible on idp-document-index."""
    table = _make_notices_table()
    table.put_item(Item=_pre_change_row())

    main(["--table", TABLE_NAME, "--region", "us-east-1", "--apply"])

    result = table.query(
        IndexName="idp-document-index",
        KeyConditionExpression=Key("idp_record").eq("document"),
    )
    notice_ids = [item["notice_id"] for item in result["Items"]]
    assert notice_ids == ["idp-NTC-0001"]
