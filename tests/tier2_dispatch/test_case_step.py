"""Tests for the map run's two guarded case writes.

The load-bearing behaviour is that a LOST RACE is a normal outcome, not an error. That is what makes
re-running a map over the same collected list free, and it is the only reason the workflow can be
retried at all.
"""

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem, ReconSide
from backend.recon_core.status import CaseStatus
from backend.tier2_dispatch import case_step


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
    return CaseStore(table="recon-cases", audit="recon-audit")


def _item(item_id: str = "i-1") -> ReconItem:
    return ReconItem(
        item_id=item_id,
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
    )


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AUDIT_TABLE", "recon-audit")


@mock_aws
def test_claim_moves_pending_to_in_progress(_env):
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)

    out = case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    assert out == {"claimed": True, "item_id": "i-1"}
    assert store.status("i-1") is CaseStatus.IN_PROGRESS


@mock_aws
def test_claiming_twice_reports_not_claimed_rather_than_failing(_env):
    """Idempotency. Re-running a map over the same list must cost nothing, not raise N times."""
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)
    case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    out = case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    assert out == {"claimed": False, "item_id": "i-1"}
    assert store.status("i-1") is CaseStatus.IN_PROGRESS


@mock_aws
def test_claiming_a_missing_case_raises(_env):
    """collect reads the case table itself, so an id with no case row is a fault, not a race."""
    _tables()

    with pytest.raises(KeyError):
        case_step.handle({"action": "claim", "item_id": "nope"}, None)


@mock_aws
def test_fail_marks_an_in_progress_case_failed(_env):
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)
    store.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)

    out = case_step.handle({"action": "fail", "item_id": "i-1", "reason": "States.Timeout"}, None)

    assert out == {"failed": True, "item_id": "i-1"}
    assert store.status("i-1") is CaseStatus.FAILED


@mock_aws
def test_fail_leaves_a_case_that_already_moved_on(_env):
    """A proposal that landed just before the state gave up must win."""
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)
    store.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)
    store.transition("item_id", "i-1", CaseStatus.PROPOSED)

    out = case_step.handle({"action": "fail", "item_id": "i-1", "reason": "boom"}, None)

    assert out == {"failed": False, "item_id": "i-1"}
    assert store.status("i-1") is CaseStatus.PROPOSED


@mock_aws
def test_fail_with_no_reason_still_records_something(_env):
    """An empty reason must not produce a FAILED case with a blank explanation."""
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)
    store.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)

    case_step.handle({"action": "fail", "item_id": "i-1"}, None)

    row = (
        boto3.resource("dynamodb", region_name="us-east-1")
        .Table("recon-cases")
        .get_item(Key={"item_id": "i-1"})["Item"]
    )
    assert row["failure_reason"]


@mock_aws
def test_an_unknown_action_raises(_env):
    """No safe default: treating a typo as `claim` would start an investigation nobody asked for."""
    _tables()

    with pytest.raises(ValueError, match="unknown case_step action"):
        case_step.handle({"action": "clam", "item_id": "i-1"}, None)


@mock_aws
@pytest.mark.parametrize("missing", ["action", "item_id"])
def test_a_missing_key_raises(_env, missing):
    _tables()
    event = {"action": "claim", "item_id": "i-1"}
    del event[missing]

    with pytest.raises(KeyError):
        case_step.handle(event, None)
