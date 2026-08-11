"""End-to-end pipeline flow (moto-backed, real handlers with injected agent fakes).

intake -> Tier-1 stream consumer -> (escalate) agent proposal persist -> human approve
(via the platform-only recon_update_status tool) -> RESOLVED. Also asserts the in-tolerance
path auto-clears without invoking the agent, and that the case carries classification + step
reasoning before approval.
"""

import json

import boto3
from boto3.dynamodb.types import TypeSerializer
from moto import mock_aws

from agent import persist_proposal, reconcile_item

from backend.intake.handler import handle as intake_handle
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import Proposal, ReasoningStep
from backend.recon_core.status import CaseStatus
from backend.status_tool.handler import handle as status_tool
from backend.tier1.handler import handle as tier1_handle


def _make_all_tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-items",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
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


def _stream_event_from_items():
    """Read the recon-items table and build a stream INSERT event for each row."""
    ser = TypeSerializer()
    items = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-items").scan()["Items"]
    return {
        "Records": [
            {"eventName": "INSERT", "dynamodb": {"NewImage": {k: ser.serialize(v) for k, v in it.items()}}}
            for it in items
        ]
    }


def _run_flow(*, amount_a: str, amount_b: str) -> str:
    item = {
        "item_id": "i-1",
        "sides": [
            {"name": "bank", "attributes": {"amount": amount_a}},
            {"name": "ledger", "attributes": {"amount": amount_b}},
        ],
    }
    intake_handle({"body": json.dumps({"domain": "cash", "items": [item]})}, None)
    # Tier-1 runs (no AGENT_RUNTIME_ARN -> escalation stops at PENDING, agent invoked manually below).
    tier1_out = tier1_handle(_stream_event_from_items(), None)
    status = tier1_out["results"][0]["status"]
    if status == "AUTO_CLEARED":
        return "AUTO_CLEARED"

    # Simulate the async agent: classify + propose (fakes), then persist as PROPOSED.
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    cases.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)
    payload = {"item": {"item_id": "i-1", "domain": "cash", "sides": item["sides"]}}
    result = reconcile_item(
        payload,
        _catalog=[
            {"name": "timing", "confidence_threshold": 0.5, "severity": "LOW",
             "description": "timing", "deterministic_eligible": False}
        ],
        _classify=lambda c: ("timing", 0.9, "value date off by 1d"),
        _investigate=lambda it, s: (
            "apply to fund X",
            0.83,
            [ReasoningStep(skill="record-match-review", confidence=0.83,
                           reasoning="amounts differ", evidence=["bank", "ledger"])],
        ),
        _skills=["record-match-review"],
    )
    persist_proposal(cases=cases, proposal=Proposal(**{k: result[k] for k in (
        "item_id", "class_id", "classification_confidence", "classification_reasoning",
        "resolution", "confidence", "steps")}))

    stored = cases.get("i-1")
    assert stored["classification_reasoning"] == "value date off by 1d"
    assert stored["steps"][0]["reasoning"] == "amounts differ"

    # Approve -> RESOLVED via the platform-only recon_update_status tool — the same guarded,
    # audited transitions the frontend BFF performs through the gateway.
    approved = status_tool({"item_id": "i-1", "new_status": "APPROVED", "actor": "analyst"})
    assert approved["transitioned"] is True
    resolved = status_tool({"item_id": "i-1", "new_status": "RESOLVED", "actor": "bff"})
    return resolved["status"]


@mock_aws
def test_out_of_tolerance_item_flows_to_resolved():
    _make_all_tables()
    assert _run_flow(amount_a="100.00", amount_b="105.00") == "RESOLVED"


@mock_aws
def test_in_tolerance_item_auto_clears_without_agent():
    _make_all_tables()
    assert _run_flow(amount_a="100.00", amount_b="100.00") == "AUTO_CLEARED"
