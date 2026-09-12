"""ClaimCase must return the FULL item, not the collected stub.

This is a regression test for a real failure: `collect` writes only
`{item_id, domain, session_id}` to S3 (deliberately, so a 5000-item run stays small), and the state
machine passed that stub through as the agent's `item`. The agent calls `ReconItem.model_validate` on
whatever it is handed, so every investigation died with:

    ValidationError: 1 validation error for ReconItem  sides  Field required

The assertion that matters is the last one in each test: the dispatched payload must actually validate
as a ReconItem. Asserting only "an item key is present" is what let the stub through in the first place.
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
    return CaseStore(table="recon-cases", audit="recon-audit")


def _item() -> ReconItem:
    return ReconItem(
        item_id="i-1",
        domain="cash",
        # `ReconSide.attributes` is str->str, so the side amounts are strings. The Decimals that make
        # the raw snapshot non-JSON-serialisable come from DynamoDB's own number handling -- see
        # test_the_returned_item_is_json_serialisable.
        sides=[
            ReconSide(name="bank", attributes={"amount": "1234.56"}),
            ReconSide(name="ledger", attributes={"amount": "1200.00"}),
        ],
        attributes={"idp_class": "LoanDrawNotice"},
    )


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AUDIT_TABLE", "recon-audit")


@mock_aws
def test_claim_returns_an_item_that_validates_as_a_ReconItem(_env):
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)

    out = case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    assert out["claimed"] is True
    # The stub had only these three keys; the real item must carry `sides`.
    assert "sides" in out["item"]
    # THE assertion. This is what the agent does, and it is what was failing in production.
    validated = ReconItem.model_validate(out["item"])
    assert [s.name for s in validated.sides] == ["bank", "ledger"]
    assert validated.attributes["idp_class"] == "LoanDrawNotice"


@mock_aws
def test_the_returned_item_is_json_serialisable(_env):
    """DynamoDB hands back Decimals; a Lambda return value must survive JSON encoding."""
    import json

    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)

    out = case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    json.dumps(out)  # must not raise on a Decimal
    side = ReconItem.model_validate(out["item"]).sides[0]
    assert float(side.attributes["amount"]) == pytest.approx(1234.56)


@mock_aws
def test_an_unclaimed_case_returns_no_item(_env):
    """Nothing reads `item` on the skip path, and fetching it would be a wasted read."""
    store = _tables()
    store.open(_item(), status=CaseStatus.PENDING, tier=2)
    case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    out = case_step.handle({"action": "claim", "item_id": "i-1"}, None)

    assert out == {"claimed": False, "item_id": "i-1", "item": {}}


@mock_aws
def test_a_case_row_with_no_item_snapshot_fails_loudly(_env):
    """Handing the agent an empty dict is the failure this guard exists to prevent."""
    _tables()
    boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").put_item(
        Item={"item_id": "i-2", "status": "PENDING", "created_at": "2026-09-11T00:00:00"}
    )

    with pytest.raises(KeyError, match="no stored item snapshot"):
        case_step.handle({"action": "claim", "item_id": "i-2"}, None)
