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
        classification_reasoning="value date off by 1d",
        resolution="apply to fund X",
        confidence=0.83,
        steps=[
            ReasoningStep(
                skill="record-match-review",
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
    # Nothing computes a classification confidence, so the attribute must be ABSENT rather than
    # written as a 0 or a None — a number on the row invites the next reader to gate on it.
    assert "classification_confidence" not in stored
    assert stored["steps"][0]["skill"] == "record-match-review"
    assert stored["steps"][0]["reasoning"] == "amounts match"
    # Nobody sets a per-step confidence, so the key must be absent rather than persisted as a
    # meaningless 0.0 — a 0.0 on the trace reads as "the agent was unsure", not "nobody measured".
    assert "confidence" not in stored["steps"][0]


@mock_aws
def test_an_evidence_step_persists_its_step_id_and_a_false_satisfied():
    """The typed-trace allowlist drops unnamed fields, so assert at the DynamoDB row, not the model.

    Adding a field to ``ReasoningStep`` does NOT make it reach DynamoDB: ``persist_proposal`` builds
    the stored dict from an explicit key list. Without this test the evidence-completeness score
    would still compute correctly in-process and only the case screen's checklist would be empty —
    a silently inert control.
    """
    _make_tables()
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    item = ReconItem(item_id="i-1", domain="cash", sides=[ReconSide(name="ledger")])
    cases.open(item, status=CaseStatus.PENDING, tier=2)
    cases.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)
    prop = Proposal(
        item_id="i-1",
        class_id="timing",
        classification_reasoning="c",
        resolution="r",
        confidence=0.5,
        steps=[
            ReasoningStep(
                skill="s",
                reasoning="looked, found nothing",
                kind="evidence_step",
                step_id="ledger_hit",
                satisfied=False,
            ),
            # Never attempted: satisfied stays None, so the key is absent rather than false.
            ReasoningStep(
                skill="s", reasoning="skipped", kind="evidence_step", step_id="notice_hit"
            ),
        ],
    )
    persist_proposal(cases=cases, proposal=prop)
    steps = cases.get("i-1")["steps"]
    assert steps[0]["step_id"] == "ledger_hit"
    # `is False`, not falsy: a truthiness filter in the allowlist would have dropped this key, and
    # "attempted and came back empty" would become indistinguishable from "never attempted".
    assert steps[0]["satisfied"] is False
    assert steps[1]["step_id"] == "notice_hit"
    assert "satisfied" not in steps[1]
    # Row-level proof that the deleted numbers are gone from STORAGE, not just from the models. A 0.0
    # written here would render on the case screen as a real self-assessment of zero, and would be
    # indistinguishable from a genuinely unevidenced step.
    assert all("confidence" not in s for s in steps)
    assert "classification_confidence" not in cases.get("i-1")
