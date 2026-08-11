"""Tests for the intake Lambda handler."""

import json

import boto3
from moto import mock_aws

from backend.intake.handler import handle


def _make_items_table():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-items",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


@mock_aws
def test_handle_writes_items_and_rejects_malformed():
    _make_items_table()
    body = {
        "domain": "cash",
        "items": [{"item_id": "i-1", "sides": [{"name": "bank"}, {"name": "ledger"}]}],
    }
    resp = handle({"body": json.dumps(body)}, None)
    assert resp["statusCode"] == 202
    assert json.loads(resp["body"])["written"] == 1

    bad = handle({"body": json.dumps({"domain": "cash"})}, None)  # no items
    assert bad["statusCode"] == 400


@mock_aws
def test_resubmission_is_idempotent():
    _make_items_table()
    body = {
        "domain": "cash",
        "items": [{"item_id": "i-1", "sides": [{"name": "bank"}, {"name": "ledger"}]}],
    }
    handle({"body": json.dumps(body)}, None)
    resp = handle({"body": json.dumps(body)}, None)  # resubmit same item
    assert json.loads(resp["body"])["written"] == 0  # skipped, not overwritten
