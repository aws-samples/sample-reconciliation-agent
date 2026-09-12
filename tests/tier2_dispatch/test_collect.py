"""Tests for the collect step: pagination, the run ceiling, and one backend read per run."""

import json

import boto3
import pytest
from moto import mock_aws

from backend.tier2_dispatch import collect


def _make_tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    table = ddb.create_table(
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
    return table


def _seed(table, n: int, status: str = "PENDING", start: int = 0):
    for i in range(start, start + n):
        table.put_item(
            Item={
                "item_id": f"i-{i:05d}",
                "status": status,
                "created_at": f"2026-09-11T00:{i // 60:02d}:{i % 60:02d}",
                "domain": "cash",
            }
        )


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("RUNS_BUCKET", "runs-bucket")
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AGENT_BACKEND_PARAM", "")
    monkeypatch.delenv("MAX_ITEMS_PER_RUN", raising=False)
    # These tests are about WHAT gets collected. The single-flight guard runs first and fails closed
    # without a state machine to query, so it is stubbed out here and covered on its own in
    # test_collect_single_flight.py.
    monkeypatch.setattr(collect, "_another_run_in_flight", lambda **_kw: False)


@mock_aws
def test_writes_only_pending_cases_to_s3(_env):
    table = _make_tables()
    _seed(table, 3, status="PENDING")
    _seed(table, 2, status="PROPOSED", start=100)
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="runs-bucket")

    out = collect.handle({"execution_name": "run-1"}, None)

    assert out["count"] == 3
    assert out["key"] == "tier2-runs/run-1.json"
    body = (
        boto3.client("s3", region_name="us-east-1")
        .get_object(Bucket="runs-bucket", Key=out["key"])["Body"]
        .read()
    )
    rows = json.loads(body)
    assert [r["item_id"] for r in rows] == ["i-00000", "i-00001", "i-00002"]
    # Only the keys the dispatcher needs — not the proposal, steps or token usage.
    assert set(rows[0]) == {"item_id", "domain", "session_id"}


@mock_aws
def test_oldest_first(_env):
    """An aging queue must investigate the longest-waiting case first."""
    table = _make_tables()
    table.put_item(
        Item={
            "item_id": "new",
            "status": "PENDING",
            "created_at": "2026-09-11T09:00:00",
            "domain": "cash",
        }
    )
    table.put_item(
        Item={
            "item_id": "old",
            "status": "PENDING",
            "created_at": "2026-09-01T09:00:00",
            "domain": "cash",
        }
    )
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="runs-bucket")

    out = collect.handle({"execution_name": "run-1"}, None)
    rows = json.loads(
        boto3.client("s3", region_name="us-east-1")
        .get_object(Bucket="runs-bucket", Key=out["key"])["Body"]
        .read()
    )

    assert [r["item_id"] for r in rows] == ["old", "new"]


@mock_aws
def test_paginates_past_one_query_page(_env):
    """A burst is the case this exists for, so a single Query page must not silently cap it."""
    table = _make_tables()
    _seed(table, 250)
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="runs-bucket")

    assert collect.handle({"execution_name": "run-1"}, None)["count"] == 250


@mock_aws
def test_the_run_ceiling_truncates_and_leaves_the_rest_pending(_env, monkeypatch):
    """MaxConcurrency bounds the RATE but not the total; this bounds the total."""
    monkeypatch.setenv("MAX_ITEMS_PER_RUN", "5")
    table = _make_tables()
    _seed(table, 20)
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="runs-bucket")

    out = collect.handle({"execution_name": "run-1"}, None)

    assert out["count"] == 5
    # The untouched cases are still PENDING, so the next run picks them up.
    assert table.get_item(Key={"item_id": "i-00019"})["Item"]["status"] == "PENDING"


@mock_aws
def test_zero_pending_is_a_normal_outcome(_env):
    _make_tables()
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="runs-bucket")

    out = collect.handle({"execution_name": "run-1"}, None)

    assert out["count"] == 0


@mock_aws
def test_the_backend_is_stamped_on_the_run(_env, monkeypatch):
    """Resolved once, here, so a run cannot straddle a mid-run backend switch."""
    _make_tables()
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="runs-bucket")
    # `collect` imports the resolver inside the function, so patch it on its own module.
    import backend.recon_core.model_select as ms

    monkeypatch.setattr(ms, "get_agent_backend", lambda _p, **_kw: "harness")

    assert collect.handle({"execution_name": "run-1"}, None)["backend"] == "harness"


@mock_aws
def test_a_missing_execution_name_raises(_env):
    """Deriving a fallback key would let two concurrent runs share one input object."""
    _make_tables()

    with pytest.raises(KeyError):
        collect.handle({}, None)
