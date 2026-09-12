"""The Tier-1 consumer opens the case PENDING and dispatches nothing.

This is the contract that lets the Tier-2 map run bound concurrency at all. If this consumer ever
dispatches again, the bound is gone: it runs one invocation per stream shard, and shard count on a
PAY_PER_REQUEST table is precisely what a large intake batch inflates, so a fan-out from here scales
with the burst it is supposed to absorb.
"""

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.cases import CaseStore
from backend.recon_core.status import CaseStatus
from backend.tier1 import handler as tier1


def _tables():
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


def _escalating_record() -> dict:
    """A record with no matching sides, so Tier-1 must escalate rather than auto-clear."""
    return {
        "eventName": "INSERT",
        "dynamodb": {
            "NewImage": {
                "item_id": {"S": "i-1"},
                "domain": {"S": "cash"},
                "sides": {
                    "L": [
                        {"M": {"name": {"S": "bank"}, "amount": {"N": "100"}}},
                        {"M": {"name": {"S": "ledger"}, "amount": {"N": "250"}}},
                    ]
                },
            }
        },
    }


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AUDIT_TABLE", "recon-audit")
    # Deterministic tier on, so escalation is a real Tier-1 miss rather than the disabled path.
    monkeypatch.setattr(tier1, "tier1_enabled", lambda: True)


@mock_aws
def test_an_escalated_case_is_left_PENDING_and_nothing_is_invoked(_env, monkeypatch):
    _tables()
    monkeypatch.setattr(
        boto3,
        "client",
        lambda *a, **k: pytest.fail("Tier-1 invoked something; it must not dispatch"),
    )

    out = tier1.handle({"Records": [_escalating_record()]}, None)

    assert out["results"][0]["escalated"] is True
    assert out["results"][0]["status"] == "PENDING"
    # The map run claims it later; until then it must be visible on the status-index as PENDING.
    store = CaseStore(table="recon-cases", audit="recon-audit")
    assert store.status("i-1") is CaseStatus.PENDING
