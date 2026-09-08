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
def test_malformed_item_returns_400_naming_the_field():
    """Intake itself must produce the 400, not just relay one.

    ``ReconSide.attributes`` is ``dict[str, str]``; an int value is a pydantic failure. Left to
    escape the ``try``, it becomes an unhandled Lambda exception, which the BFF surfaces as a 502 with
    a raw traceback. A frontend test against a mocked Lambda cannot catch that — only this can.
    """
    _make_items_table()
    body = {
        "domain": "cash",
        "items": [{"item_id": "i-1", "sides": [{"name": "bank", "attributes": {"amount": 100}}]}],
    }
    resp = handle({"body": json.dumps(body)}, None)
    assert resp["statusCode"] == 400
    error = json.loads(resp["body"])["error"]
    assert "attributes" in error and "amount" in error
    assert "errors.pydantic.dev" not in error  # include_url=False keeps the UI toast readable


@mock_aws
def test_a_batch_with_one_bad_item_writes_nothing(monkeypatch):
    """All-or-nothing. A 6-item paste with a typo in item 4 must not leave 3 items in the table with
    Tier-1 already running on them — the operator's retry would then report `written: 0`, which is
    indistinguishable from "nothing happened"."""
    _make_items_table()
    calls = []
    monkeypatch.setattr(
        "backend.recon_core.ddb.ItemStore.put_if_absent",
        lambda self, item: calls.append(item.item_id) or True,
    )
    items = [{"item_id": f"i-{n}", "sides": [{"name": "bank"}]} for n in range(6)]
    items[3]["sides"] = "not-a-list"
    resp = handle({"body": json.dumps({"domain": "cash", "items": items})}, None)
    assert resp["statusCode"] == 400
    assert calls == [], f"wrote {calls} before rejecting the batch"


@mock_aws
def test_non_mapping_item_returns_400_not_a_traceback():
    """``**raw`` on a JSON string raises TypeError before pydantic is reached."""
    _make_items_table()
    resp = handle({"body": json.dumps({"domain": "cash", "items": ["just-a-string"]})}, None)
    assert resp["statusCode"] == 400
    assert "invalid item" in json.loads(resp["body"])["error"]


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
