"""Tests for the IDP post-processing hook Lambda handler."""

import json

import boto3
from moto import mock_aws

from backend.idp_hook.handler import handle


def _make_items_table():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-items",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _make_case_tables():
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


def _event(doc, *, execution_arn="arn:aws:states:::execution:idp:run-1"):
    # IDP delivers detail.output as a JSON-ENCODED STRING containing {"document": {...}}, with
    # the per-run id at detail.executionArn.
    return {
        "detail": {
            "status": "SUCCEEDED",
            "executionArn": execution_arn,
            "output": json.dumps({"document": doc}),
        }
    }


# Includes a FLOAT confidence — proves the end-to-end DynamoDB put survives (would crash without
# the mapper's float→Decimal conversion).
DOC = {
    "id": "doc-1",
    "input_key": "n/1.pdf",
    "output_bucket": "idp-out",
    "sections": [
        {
            "section_id": "s0",
            "classification": "Notice",
            "extraction_result_uri": "s3://idp-out/n/1.pdf/sections/s0/result.json",
            "attributes": {"total_amount": "10.00"},
            "confidence_threshold_alerts": [
                {"attribute_name": "total_amount", "confidence": 0.93, "confidence_threshold": 0.8}
            ],
        }
    ],
}


@mock_aws
def test_handle_writes_recon_item(monkeypatch):
    monkeypatch.setenv("ITEMS_TABLE", "recon-items")
    monkeypatch.setenv("RECON_DOMAIN", "cash")
    _make_items_table()
    out = handle(_event(DOC), None)
    assert out["written"] == 1
    assert out["outcome"] == "created"
    from backend.recon_core.ddb import ItemStore

    stored = ItemStore(table_name="recon-items").get("idp-doc-1")
    assert stored.attributes["idp_class"] == "Notice"
    # The per-run id is captured so a later reprocess can be distinguished.
    assert stored.attributes["idp_execution_arn"] == "arn:aws:states:::execution:idp:run-1"


@mock_aws
def test_redelivery_same_run_is_idempotent(monkeypatch):
    """A re-delivered IDENTICAL completion event (same executionArn) is a no-op."""
    monkeypatch.setenv("ITEMS_TABLE", "recon-items")
    monkeypatch.setenv("RECON_DOMAIN", "cash")
    _make_items_table()
    handle(_event(DOC, execution_arn="run-A"), None)
    out = handle(_event(DOC, execution_arn="run-A"), None)  # same doc AND same run
    assert out["written"] == 0
    assert out["redriven"] == 0
    assert out["outcome"] == "duplicate"


@mock_aws
def test_reprocess_new_run_redrives_case(monkeypatch):
    """A NEW IDP run (different executionArn) of an already-ingested doc overwrites the item and
    re-drives its case — even from a terminal RESOLVED state."""
    monkeypatch.setenv("ITEMS_TABLE", "recon-items")
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AUDIT_TABLE", "recon-audit")
    monkeypatch.setenv("RECON_DOMAIN", "cash")
    monkeypatch.setenv("REPROCESS_CAP", "3")
    # No AGENT_WORKER_FUNCTION/AGENT_RUNTIME_ARN → redrive stops at PENDING (no dispatch).
    _make_items_table()
    _make_case_tables()

    from backend.recon_core.cases import CaseStore
    from backend.recon_core.schema import ReconItem
    from backend.recon_core.status import CaseStatus

    # First ingest, then simulate the case having reached terminal RESOLVED.
    handle(_event(DOC, execution_arn="run-A"), None)
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    item = ReconItem.model_validate(
        {
            "item_id": "idp-doc-1",
            "domain": "cash",
            "sides": [],
            "attributes": {"idp_execution_arn": "run-A"},
            "tier": 1,
        }
    )
    cases.open(item, status=CaseStatus.PENDING, tier=2)
    cases._cases.update_item(  # force to terminal for the test
        Key={"item_id": "idp-doc-1"},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": CaseStatus.RESOLVED.value},
    )

    out = handle(_event(DOC, execution_arn="run-B"), None)  # NEW run
    assert out["redriven"] == 1
    assert out["outcome"] == "redriven"
    assert cases.status("idp-doc-1") == CaseStatus.PENDING


@mock_aws
def test_reprocess_ages_out_at_cap(monkeypatch):
    """When the reprocess counter exceeds the cap, an IDP re-drive ages the case out (AGED)
    instead of re-investigating — mirroring the reject->reprocess cap."""
    monkeypatch.setenv("ITEMS_TABLE", "recon-items")
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AUDIT_TABLE", "recon-audit")
    monkeypatch.setenv("RECON_DOMAIN", "cash")
    monkeypatch.setenv("REPROCESS_CAP", "1")
    _make_items_table()
    _make_case_tables()

    from backend.recon_core.cases import CaseStore
    from backend.recon_core.schema import ReconItem
    from backend.recon_core.status import CaseStatus

    handle(_event(DOC, execution_arn="run-A"), None)
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    item = ReconItem.model_validate(
        {
            "item_id": "idp-doc-1",
            "domain": "cash",
            "sides": [],
            # Already at the cap (1) — the next re-drive pushes count to 2 > 1.
            "attributes": {"idp_execution_arn": "run-A", "reprocess_count": 1},
            "tier": 1,
        }
    )
    cases.open(item, status=CaseStatus.PENDING, tier=2)

    out = handle(_event(DOC, execution_arn="run-B"), None)
    assert out["outcome"] == "aged"
    assert cases.status("idp-doc-1") == CaseStatus.AGED


@mock_aws
def test_non_succeeded_event_is_ignored(monkeypatch):
    monkeypatch.setenv("ITEMS_TABLE", "recon-items")
    _make_items_table()
    ev = {"detail": {"status": "FAILED", "output": json.dumps({"document": DOC})}}
    assert handle(ev, None)["written"] == 0
