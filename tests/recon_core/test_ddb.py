"""Tests for the DynamoDB ItemStore helper (moto-mocked)."""

import boto3
from moto import mock_aws

from backend.recon_core.ddb import ItemStore
from backend.recon_core.schema import ReconItem, ReconSide


def _make_items_table():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-items",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


@mock_aws
def test_get_returns_the_written_item():
    _make_items_table()
    store = ItemStore(table_name="recon-items")
    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
    )
    assert store.put_if_absent(item) is True
    assert store.get("i-1").domain == "cash"


@mock_aws
def test_put_if_absent_is_conditional():
    _make_items_table()
    store = ItemStore(table_name="recon-items")
    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
    )
    assert store.put_if_absent(item) is True  # first write creates
    assert store.put_if_absent(item) is False  # duplicate skipped, not overwritten


def _item(arn: str, amount: str = "1.00") -> ReconItem:
    return ReconItem(
        item_id="idp-doc.pdf",
        domain="cash",
        sides=[],
        attributes={"idp_execution_arn": arn, "amt": amount},
    )


@mock_aws
def test_put_and_detect_reprocess_created():
    _make_items_table()
    store = ItemStore(table_name="recon-items")
    assert store.put_and_detect_reprocess(_item("run-A")) == "created"


@mock_aws
def test_put_and_detect_reprocess_same_run_is_duplicate():
    _make_items_table()
    store = ItemStore(table_name="recon-items")
    store.put_and_detect_reprocess(_item("run-A"))
    assert store.put_and_detect_reprocess(_item("run-A", amount="9.99")) == "duplicate"
    # Duplicate must NOT overwrite the stored item.
    assert store.get("idp-doc.pdf").attributes["amt"] == "1.00"


@mock_aws
def test_put_and_detect_reprocess_new_run_overwrites():
    _make_items_table()
    store = ItemStore(table_name="recon-items")
    store.put_and_detect_reprocess(_item("run-A"))
    assert store.put_and_detect_reprocess(_item("run-B", amount="9.99")) == "reprocessed"
    # New run overwrites with the fresh extraction.
    assert store.get("idp-doc.pdf").attributes["amt"] == "9.99"


@mock_aws
def test_put_and_detect_reprocess_empty_stored_arn_redrives_once():
    """A pre-existing item written before idp_execution_arn existed (empty stored arn) should
    re-drive once when a real run id arrives."""
    _make_items_table()
    store = ItemStore(table_name="recon-items")
    store.put_if_absent(_item(""))  # legacy item, no run id
    assert store.put_and_detect_reprocess(_item("run-A")) == "reprocessed"
