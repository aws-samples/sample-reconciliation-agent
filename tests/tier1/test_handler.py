"""Tests for the Tier-1 DynamoDB-Stream consumer handler."""

import boto3
from boto3.dynamodb.types import TypeSerializer
from moto import mock_aws

from backend.tier1.handler import handle


def _make_tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "status", "AttributeType": "S"},
            {"AttributeName": "created_at", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "status-index",
                "KeySchema": [
                    {"AttributeName": "status", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName="recon-audit",
        KeySchema=[
            {"AttributeName": "item_id", "KeyType": "HASH"},
            {"AttributeName": "ts", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "ts", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _stream_event(item: dict) -> dict:
    """Build a realistic DynamoDB Stream INSERT event (typed NewImage)."""
    ser = TypeSerializer()
    image = {k: ser.serialize(v) for k, v in item.items()}
    return {"Records": [{"eventName": "INSERT", "dynamodb": {"NewImage": image}}]}


_ITEM = {
    "item_id": "i-1",
    "domain": "cash",
    "sides": [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "100.00"}},
    ],
    "source_refs": [],
    "tier": 1,
}


@mock_aws
def test_resolved_item_writes_auto_cleared_case():
    _make_tables()
    out = handle(_stream_event(_ITEM), None)
    assert out["results"][0]["status"] == "AUTO_CLEARED"
    assert out["results"][0]["escalated"] is False


@mock_aws
def test_duplicate_stream_delivery_is_idempotent():
    _make_tables()
    handle(_stream_event(_ITEM), None)
    out = handle(_stream_event(_ITEM), None)  # redelivery
    assert out["results"][0]["status"] == "DUPLICATE_SKIPPED"


@mock_aws
def test_out_of_tolerance_item_escalates_to_pending():
    _make_tables()
    item = dict(_ITEM, item_id="i-2")
    item["sides"] = [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "105.00"}},
    ]
    out = handle(_stream_event(item), None)  # no AGENT_RUNTIME_ARN set -> invoke skipped
    assert out["results"][0]["status"] == "PENDING"
    assert out["results"][0]["escalated"] is True


@mock_aws
def test_tier1_disabled_escalates_a_matching_item(monkeypatch):
    """When the Tier-1 deterministic route is turned OFF via config, an item that WOULD
    auto-clear is instead escalated to Tier-2 (opens PENDING, no AUTO_CLEARED)."""
    _make_tables()
    # A perfectly-matching item that would normally AUTO_CLEAR.
    monkeypatch.setattr("backend.tier1.handler.tier1_enabled", lambda: False)
    out = handle(_stream_event(_ITEM), None)
    assert out["results"][0]["status"] == "PENDING"
    assert out["results"][0]["escalated"] is True


@mock_aws
def test_tier1_enabled_by_default_auto_clears(monkeypatch):
    """With the toggle ON (default), a matching item auto-clears as before."""
    _make_tables()
    monkeypatch.setattr("backend.tier1.handler.tier1_enabled", lambda: True)
    out = handle(_stream_event(_ITEM), None)
    assert out["results"][0]["status"] == "AUTO_CLEARED"
