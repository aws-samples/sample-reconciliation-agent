"""Tests that the agent persists its proposal as a PROPOSED case with reasoning."""

import boto3
from moto import mock_aws

from agent import persist_proposal

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import Proposal, ReasoningStep, ReconItem, ReconSide
from backend.recon_core.status import CaseStatus


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
def test_persist_proposal_writes_proposed_case_with_reasoning():
    _make_tables()
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    item = ReconItem(
        item_id="i-1", domain="cash", sides=[ReconSide(name="bank"), ReconSide(name="ledger")]
    )
    cases.open(item, status=CaseStatus.PENDING, tier=2)
    cases.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)
    prop = Proposal(
        item_id="i-1",
        class_id="timing",
        classification_confidence=0.9,
        classification_reasoning="value date off by 1d",
        resolution="apply to fund X",
        confidence=0.83,
        steps=[
            ReasoningStep(
                skill="record-match-review",
                confidence=0.83,
                reasoning="amounts match",
                evidence=["bank=100.00"],
            )
        ],
    )
    persist_proposal(cases=cases, proposal=prop)
    assert cases.status("i-1") == CaseStatus.PROPOSED
    stored = cases.get("i-1")
    assert stored["resolution"] == "apply to fund X"
    assert str(stored["confidence"]) == "0.83"  # Decimal
    assert stored["classification_reasoning"] == "value date off by 1d"
    assert str(stored["classification_confidence"]) == "0.9"  # Decimal
    assert stored["steps"][0]["skill"] == "record-match-review"
    assert stored["steps"][0]["reasoning"] == "amounts match"
