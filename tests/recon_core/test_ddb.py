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
