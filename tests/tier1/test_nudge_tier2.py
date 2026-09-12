"""Tier-1 nudges the Tier-2 runner, once per batch, and never fails the batch to do it.

The nudge is what makes a console submission investigate in seconds instead of waiting for the
schedule. Two properties are load-bearing and neither is obvious:

* ONCE PER BATCH — a burst is thousands of records, and one start per escalation would be thousands
  of StartExecution calls to accomplish what one does;
* NEVER RAISES — the schedule is the backstop, so a nudge failure must cost latency, not the batch.
  Raising would fail the auto-cleared items in the same batch too.
"""

import boto3
import pytest
from moto import mock_aws

from backend.tier1 import handler as tier1


def _tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
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


def _escalating(item_id: str) -> dict:
    """A record with mismatched sides, so Tier-1 must escalate rather than auto-clear."""
    return {
        "eventName": "INSERT",
        "dynamodb": {
            "NewImage": {
                "item_id": {"S": item_id},
                "domain": {"S": "cash"},
                "sides": {
                    "L": [
                        {
                            "M": {
                                "name": {"S": "bank"},
                                "attributes": {"M": {"amount": {"S": "100"}}},
                            }
                        },
                        {
                            "M": {
                                "name": {"S": "ledger"},
                                "attributes": {"M": {"amount": {"S": "250"}}},
                            }
                        },
                    ]
                },
            }
        },
    }


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AUDIT_TABLE", "recon-audit")
    monkeypatch.setenv(
        "TIER2_STATE_MACHINE_ARN", "arn:aws:states:us-east-1:1:stateMachine:recon-dev-tier2"
    )
    monkeypatch.setattr(tier1, "tier1_enabled", lambda: True)


def _sfn(calls: list):
    class _C:
        def start_execution(self, **kw):
            calls.append(kw)
            return {"executionArn": "arn:aws:states:us-east-1:1:execution:recon-dev-tier2:x"}

    return lambda _n, **_kw: _C()


@mock_aws
def test_one_nudge_per_batch_not_per_record(_env, monkeypatch):
    """Three escalations in one batch must produce ONE StartExecution, not three."""
    _tables()
    calls: list = []
    monkeypatch.setattr(tier1.boto3, "client", _sfn(calls))

    out = tier1.handle(
        {"Records": [_escalating("i-1"), _escalating("i-2"), _escalating("i-3")]}, None
    )

    assert sum(1 for r in out["results"] if r["escalated"]) == 3
    assert len(calls) == 1, f"expected one nudge per batch, got {len(calls)}"
    assert calls[0]["stateMachineArn"].endswith("recon-dev-tier2")


@mock_aws
def test_no_nudge_when_nothing_escalated(_env, monkeypatch):
    """An all-auto-cleared batch has nothing for Tier-2 to do; starting a run would be pure noise."""
    _tables()
    calls: list = []
    monkeypatch.setattr(tier1.boto3, "client", _sfn(calls))
    matching = {
        "eventName": "INSERT",
        "dynamodb": {
            "NewImage": {
                "item_id": {"S": "ok-1"},
                "domain": {"S": "cash"},
                "sides": {
                    "L": [
                        {
                            "M": {
                                "name": {"S": "bank"},
                                "attributes": {"M": {"amount": {"S": "100"}}},
                            }
                        },
                        {
                            "M": {
                                "name": {"S": "ledger"},
                                "attributes": {"M": {"amount": {"S": "100"}}},
                            }
                        },
                    ]
                },
            }
        },
    }

    tier1.handle({"Records": [matching]}, None)

    assert calls == []


@mock_aws
def test_a_failed_nudge_does_not_fail_the_batch(_env, monkeypatch):
    """The schedule is the backstop. Raising here would also fail the auto-cleared items alongside."""
    _tables()

    class _Boom:
        def start_execution(self, **_kw):
            raise RuntimeError("throttled")

    monkeypatch.setattr(tier1.boto3, "client", lambda _n, **_kw: _Boom())

    out = tier1.handle({"Records": [_escalating("i-1")]}, None)

    assert out["results"][0]["escalated"] is True
    assert out["results"][0]["status"] == "PENDING"


@mock_aws
def test_no_nudge_attempted_when_unwired(_env, monkeypatch):
    """An empty ARN means the schedule is the only trigger — correct, and silent rather than noisy."""
    _tables()
    monkeypatch.delenv("TIER2_STATE_MACHINE_ARN", raising=False)
    monkeypatch.setattr(
        tier1.boto3, "client", lambda _n, **_kw: pytest.fail("built a client with no ARN")
    )

    tier1.handle({"Records": [_escalating("i-1")]}, None)
