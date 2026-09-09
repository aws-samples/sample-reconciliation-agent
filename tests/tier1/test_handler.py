"""Tests for the Tier-1 DynamoDB-Stream consumer handler."""

import boto3
from boto3.dynamodb.types import TypeSerializer
from moto import mock_aws

from backend.tier1.handler import handle


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


def _stream_event(item: dict) -> dict:
    """Build a realistic DynamoDB Stream INSERT event (typed NewImage)."""
    ser = TypeSerializer()
    image = {k: ser.serialize(v) for k, v in item.items()}
    return {"Records": [{"eventName": "INSERT", "dynamodb": {"NewImage": image}}]}


_ITEM = {
    "item_id": "i-1",
    "domain": "cash",
    "sides": [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "100.00"}},
    ],
    "source_refs": [],
    "tier": 1,
}


@mock_aws
def test_resolved_item_writes_auto_cleared_case():
    _make_tables()
    out = handle(_stream_event(_ITEM), None)
    assert out["results"][0]["status"] == "AUTO_CLEARED"
    assert out["results"][0]["escalated"] is False


@mock_aws
def test_duplicate_stream_delivery_is_idempotent():
    _make_tables()
    handle(_stream_event(_ITEM), None)
    out = handle(_stream_event(_ITEM), None)  # redelivery
    assert out["results"][0]["status"] == "DUPLICATE_SKIPPED"


@mock_aws
def test_out_of_tolerance_item_escalates_to_pending():
    _make_tables()
    item = dict(_ITEM, item_id="i-2")
    item["sides"] = [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "105.00"}},
    ]
    out = handle(_stream_event(item), None)  # no AGENT_RUNTIME_ARN set -> invoke skipped
    assert out["results"][0]["status"] == "PENDING"
    assert out["results"][0]["escalated"] is True


@mock_aws
def test_tier1_disabled_escalates_a_matching_item(monkeypatch):
    """When the Tier-1 deterministic route is turned OFF via config, an item that WOULD
    auto-clear is instead escalated to Tier-2 (opens PENDING, no AUTO_CLEARED)."""
    _make_tables()
    # A perfectly-matching item that would normally AUTO_CLEAR.
    monkeypatch.setattr("backend.tier1.handler.tier1_enabled", lambda: False)
    out = handle(_stream_event(_ITEM), None)
    assert out["results"][0]["status"] == "PENDING"
    assert out["results"][0]["escalated"] is True


@mock_aws
def test_tier1_enabled_by_default_auto_clears(monkeypatch):
    """With the toggle ON (default), a matching item auto-clears as before."""
    _make_tables()
    monkeypatch.setattr("backend.tier1.handler.tier1_enabled", lambda: True)
    out = handle(_stream_event(_ITEM), None)
    assert out["results"][0]["status"] == "AUTO_CLEARED"


@mock_aws
def test_escalated_case_carries_the_reason_and_the_break_type():
    """Both `tier1_*` keys are on the case at PENDING time, from one writer.

    The classification is plain Python (no S3, no network), which is what lets it run here on the
    stream shard instead of one hop later in the agent-worker — and running here is what puts it on
    the case record at open time, with no follow-up UpdateItem.
    """
    _make_tables()
    item = dict(_ITEM, item_id="i-3")
    item["sides"] = [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "105.00"}},
    ]
    out = handle(_stream_event(item), None)
    assert out["results"][0]["reason"] == "tolerance_miss"

    stored = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases")
    attributes = stored.get_item(Key={"item_id": "i-3"})["Item"]["item"]["attributes"]
    assert attributes["tier1_escalation_reason"] == "tolerance_miss"
    assert attributes["tier1_break_type"] == "record-match-review"


@mock_aws
def test_an_unclassifiable_escalation_omits_the_break_type():
    """One side is a shape no rule claims — escalate unclassified rather than guess.

    The key must be ABSENT, not empty: the agent branches on presence, and "" would name a class no
    skill can satisfy.
    """
    _make_tables()
    item = dict(_ITEM, item_id="i-5")
    item["sides"] = [{"name": "bank", "attributes": {"amount": "100.00"}}]
    handle(_stream_event(item), None)

    stored = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases")
    attributes = stored.get_item(Key={"item_id": "i-5"})["Item"]["item"]["attributes"]
    assert attributes["tier1_escalation_reason"] == "side_count"
    assert "tier1_break_type" not in attributes


@mock_aws
def test_disabled_tier1_names_itself_as_the_reason(monkeypatch):
    """A toggled-off deterministic tier is not the same escalation as a real tolerance miss."""
    _make_tables()
    monkeypatch.setattr("backend.tier1.handler.tier1_enabled", lambda: False)
    out = handle(_stream_event(dict(_ITEM, item_id="i-4")), None)
    assert out["results"][0]["reason"] == "tier1_disabled"


@mock_aws
def test_disabled_tier1_also_stops_classifying(monkeypatch):
    """The kill switch means Tier-1 contributes NOTHING, not "nothing but a hint".

    Someone debugging why the agent followed a particular skill needs a way to take Tier-1 out of the
    picture entirely; leaving the class stamped would make the toggle misleading at exactly the
    moment it is being relied on.
    """
    _make_tables()
    monkeypatch.setattr("backend.tier1.handler.tier1_enabled", lambda: False)
    item = dict(_ITEM, item_id="i-6")
    item["sides"] = [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "100.00"}},
    ]
    handle(_stream_event(item), None)

    stored = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases")
    attributes = stored.get_item(Key={"item_id": "i-6"})["Item"]["item"]["attributes"]
    assert attributes["tier1_escalation_reason"] == "tier1_disabled"
    assert "tier1_break_type" not in attributes


@mock_aws
def test_rule_auto_clear_persists_the_comparison_on_the_case():
    """The case row has to carry the explanation, not just the verdict.

    The case screen reads this attribute; without it an auto-cleared case renders every panel empty
    and, before this existed, told the operator the case escalated for a human decision.
    """
    _make_tables()
    item = dict(_ITEM, item_id="i-match")
    item["sides"] = [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "100.02"}},
    ]
    handle(_stream_event(item), None)

    stored = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases")
    row = stored.get_item(Key={"item_id": "i-match"})["Item"]
    assert row["status"] == "AUTO_CLEARED"
    assert row["category"] == "amount-match"
    assert row["tier1_match"]["matched_on"] == "rule"
    assert row["tier1_match"]["side_a_value"] == "100.00"
    assert row["tier1_match"]["side_b_value"] == "100.02"
    assert row["tier1_match"]["difference"] == "0.02"
    assert row["tier1_match"]["tolerance"] == "0.05"


@mock_aws
def test_gl_auto_clear_persists_the_matched_ledger_row(monkeypatch):
    """A ledger auto-clear is explained by the row it matched, so the row travels with the case."""
    _make_tables()
    monkeypatch.setenv("GL_QUERY_FUNCTION", "gl-query")

    ledger_row = {
        "entry_id": "GL-1",
        "borrower": "ACME LTD",
        "entry_type": "CREDIT",
        "amount": 500.0,
    }
    evidence = {
        "borrower": "ACME LTD",
        "entry_type": "CREDIT",
        "tolerance": "0.05",
        "extracted_amount": "500.0",
        "ledger_amount": "500.0",
        "difference": "0.0",
        "candidates_considered": "1",
        "ledger_rows_returned": "1",
    }
    import backend.tier1.gl_match as gl_match_module

    monkeypatch.setattr(
        gl_match_module,
        "gl_lookup",
        lambda item, *, invoker: gl_match_module.GlMatch(row=ledger_row, match=evidence),
    )

    item = dict(_ITEM, item_id="i-gl")
    item["sides"] = []
    handle(_stream_event(item), None)

    stored = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases")
    row = stored.get_item(Key={"item_id": "i-gl"})["Item"]
    assert row["status"] == "AUTO_CLEARED"
    assert row["category"] == "gl-match"
    assert row["tier1_match"]["matched_on"] == "general_ledger"
    assert row["tier1_match"]["extracted_amount"] == "500.0"
    # Stringified on the way in: the query Lambda returns JSON, so the amount arrives as a float and
    # boto3 refuses to write a float to DynamoDB.
    assert row["tier1_match"]["ledger_row"]["amount"] == "500.0"
    assert row["tier1_match"]["ledger_row"]["entry_id"] == "GL-1"


@mock_aws
def test_escalated_case_carries_no_match_evidence():
    """An escalation has nothing to explain, and an empty dict would read as a failed measurement."""
    _make_tables()
    item = dict(_ITEM, item_id="i-esc")
    item["sides"] = [
        {"name": "bank", "attributes": {"amount": "100.00"}},
        {"name": "ledger", "attributes": {"amount": "900.00"}},
    ]
    handle(_stream_event(item), None)

    stored = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases")
    row = stored.get_item(Key={"item_id": "i-esc"})["Item"]
    assert row["status"] == "PENDING"
    assert "tier1_match" not in row


def test_missing_rule_evidence_raises_instead_of_writing_a_bare_case():
    """An auto-cleared case with no explanation is the defect this evidence exists to remove.

    Returning an empty dict here would reintroduce it one refactor later with every test still green,
    so the assembly fails loudly when the resolving path supplied nothing.
    """
    import pytest

    from backend.tier1.handler import _auto_clear_evidence

    with pytest.raises(ValueError, match="no match evidence"):
        _auto_clear_evidence(resolved_by_rule=True, rule_match=None, gl_evidence=None, gl_row=None)
    with pytest.raises(ValueError, match="no match evidence"):
        _auto_clear_evidence(
            resolved_by_rule=False, rule_match=None, gl_evidence=None, gl_row={"entry_id": "GL-1"}
        )
