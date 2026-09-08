"""Tests for the agent invoker (Tier-1 -> IN_PROGRESS -> async dispatch)."""

import boto3
from moto import mock_aws

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem, ReconSide
from backend.recon_core.status import CaseStatus
from backend.tier1.invoke_agent import invoke_recon_agent


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


@mock_aws
def test_invoker_sets_in_progress_and_dispatches(monkeypatch):
    _make_tables()
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    item = ReconItem(
        item_id="i-1", domain="cash", sides=[ReconSide(name="bank"), ReconSide(name="ledger")]
    )
    cases.open(item, status=CaseStatus.PENDING, tier=2)
    called = {}
    monkeypatch.setattr(
        "backend.tier1.invoke_agent._dispatch",
        lambda arn, payload: called.update(arn=arn, payload=payload),
    )
    invoke_recon_agent(agent_arn="arn:aws:...:runtime/recon", item=item, cases=cases)
    assert cases.status("i-1") == CaseStatus.IN_PROGRESS
    assert called["payload"]["item"]["item_id"] == "i-1"
    assert len(called["payload"]["session_id"]) >= 33  # AgentCore session-id min length


@mock_aws
def test_dispatch_serializes_decimal_attributes(monkeypatch):
    """IDP-enriched items carry Decimal attributes; the REAL _dispatch json.dumps must not
    crash on them (regression: TypeError: Object of type Decimal is not JSON serializable)."""
    from decimal import Decimal

    _make_tables()
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    item = ReconItem(
        item_id="i-dec",
        domain="cash",
        sides=[],
        attributes={"idp_sections": [{"fields": {"GlobalAmount": Decimal("150800000.0")}}]},
    )
    cases.open(item, status=CaseStatus.PENDING, tier=2)

    sent = {}

    class _FakeLambda:
        def invoke(self, **kw):
            sent.update(kw)
            return {"StatusCode": 202}

    monkeypatch.setenv("AGENT_WORKER_FUNCTION", "recon-agent-worker")
    monkeypatch.setattr(
        "backend.tier1.invoke_agent.boto3.client", lambda service: _FakeLambda()
    )
    # Uses the REAL _dispatch (json.dumps path), which is where a raw Decimal blows up.
    invoke_recon_agent(agent_arn="arn:aws:...:runtime/recon", item=item, cases=cases)
    import json as _json

    payload = _json.loads(sent["Payload"].decode())
    amount = payload["item"]["attributes"]["idp_sections"][0]["fields"]["GlobalAmount"]
    assert amount == "150800000.0"  # Decimal serialized as string, not a crash


def test_session_id_sanitizes_filename_characters():
    """AgentCore session ids must match [a-zA-Z0-9][a-zA-Z0-9-_]* — IDP item ids carry dots/#."""
    import re

    from backend.tier1.invoke_agent import _session_id

    sid = _session_id("idp-Borrowing_Notice_#3.pdf")
    assert re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9-_]*", sid), sid
    assert len(sid) >= 33
    # Deterministic (idempotent re-invocations reuse the same session).
    assert sid == _session_id("idp-Borrowing_Notice_#3.pdf")
