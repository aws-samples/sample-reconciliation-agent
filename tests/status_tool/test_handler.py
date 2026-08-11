"""Tests for the platform-only recon_update_status gateway tool."""

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem
from backend.recon_core.status import CaseStatus
from backend.status_tool.handler import handle


def _make_tables():
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


def _open_case(item_id: str = "i-1", status: CaseStatus = CaseStatus.PROPOSED) -> CaseStore:
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    cases.open(ReconItem(item_id=item_id, domain="cash", sides=[]), status=CaseStatus.PENDING, tier=2)
    # Walk the case to the requested starting status through legal transitions.
    walk = {
        CaseStatus.PENDING: [],
        CaseStatus.IN_PROGRESS: [CaseStatus.IN_PROGRESS],
        CaseStatus.PROPOSED: [CaseStatus.IN_PROGRESS, CaseStatus.PROPOSED],
        CaseStatus.REJECTED: [CaseStatus.IN_PROGRESS, CaseStatus.PROPOSED, CaseStatus.REJECTED],
    }[status]
    for step in walk:
        assert cases.transition("item_id", item_id, step)
    return cases


@mock_aws
def test_legal_transition_moves_case_and_audits_actor():
    """A legal transition advances the case and records the actor+comment in the audit note."""
    _make_tables()
    _open_case(status=CaseStatus.PROPOSED)
    out = handle({"item_id": "i-1", "new_status": "APPROVED",
                  "actor": "analyst:jdoe", "comment": "looks right"})
    assert out == {"item_id": "i-1", "status": "APPROVED", "transitioned": True}
    audit = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-audit").scan()
    notes = [row["note"] for row in audit["Items"]]
    assert any("analyst:jdoe: looks right" in n for n in notes)


@mock_aws
def test_illegal_transition_reports_current_status():
    """A disallowed transition is not an error: transitioned=false + the unchanged status."""
    _make_tables()
    _open_case(status=CaseStatus.PROPOSED)
    out = handle({"item_id": "i-1", "new_status": "RESOLVED"})  # PROPOSED->RESOLVED is illegal
    assert out == {"item_id": "i-1", "status": "PROPOSED", "transitioned": False}


@mock_aws
def test_rejected_to_aged_is_allowed():
    """The re-process cap path (REJECTED->AGED) works through the tool."""
    _make_tables()
    _open_case(status=CaseStatus.REJECTED)
    out = handle({"item_id": "i-1", "new_status": "AGED", "actor": "bff"})
    assert out["transitioned"] is True
    assert out["status"] == "AGED"


@mock_aws
def test_unknown_status_and_missing_item_raise():
    """Bad inputs are loud errors (surfaced as gateway tool errors), never silent writes."""
    _make_tables()
    _open_case()
    with pytest.raises(ValueError, match="unknown new_status"):
        handle({"item_id": "i-1", "new_status": "SHIPPED"})
    with pytest.raises(ValueError, match="item_id is required"):
        handle({"new_status": "APPROVED"})
    with pytest.raises(KeyError):
        handle({"item_id": "nope", "new_status": "APPROVED"})
