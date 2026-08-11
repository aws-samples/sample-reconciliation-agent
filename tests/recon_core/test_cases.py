"""Tests for the CaseStore write invariants (moto-mocked).

Covers the two guarantees documented in ``backend/recon_core/cases.py``: only ``open()`` may
create a case row, and audit rows are append-only (never overwritten by a ts collision).
"""

from datetime import datetime, timezone
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem
from backend.recon_core.status import CaseStatus

# A fixed instant used to force audit-ts collisions (see _freeze_clock).
_FROZEN = datetime(2026, 8, 5, 7, 17, 25, 205934, tzinfo=timezone.utc)


def _freeze_clock(monkeypatch) -> None:
    """Pin ``cases.datetime.now()`` to _FROZEN so every audit row starts at the same microsecond.

    :param monkeypatch: pytest's monkeypatch fixture.
    :returns: None
    """
    monkeypatch.setattr(
        "backend.recon_core.cases.datetime",
        type("FrozenDatetime", (), {"now": staticmethod(lambda tz=None: _FROZEN)}),
    )


def _make_tables() -> None:
    """Create the cases table (with the status-index GSI) and the audit table in moto."""
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


def _store() -> CaseStore:
    """Return a CaseStore bound to the moto tables."""
    return CaseStore(table="recon-cases", audit="recon-audit")


def _item(item_id: str = "i-1") -> ReconItem:
    """Return a minimal ReconItem for the given id."""
    return ReconItem(item_id=item_id, domain="cash", sides=[])


def _raw_table(name: str):
    """Return the raw boto3 Table resource, bypassing CaseStore, for assertions."""
    return boto3.resource("dynamodb", region_name="us-east-1").Table(name)


def _audit_rows(item_id: str) -> list[dict]:
    """Return the item's audit rows in DynamoDB RANGE-key (ts) order."""
    resp = _raw_table("recon-audit").query(
        KeyConditionExpression="item_id = :i",
        ExpressionAttributeValues={":i": item_id},
    )
    return resp["Items"]


def _proposal_kwargs(item_id: str) -> dict:
    """Return a full set of attach_proposal arguments for the given case."""
    return {
        "item_id": item_id,
        "class_id": "timing-difference",
        "classification_confidence": Decimal("0.9"),
        "classification_reasoning": "value dates differ by one business day",
        "resolution": "monitor",
        "confidence": Decimal("0.8"),
        "steps": [{"skill": "timing"}],
    }


@mock_aws
def test_attach_proposal_refuses_to_create_a_case_row():
    """A proposal for an item with no case row raises instead of upserting a statusless orphan."""
    _make_tables()
    cases = _store()
    with pytest.raises(KeyError, match="not found"):
        cases.attach_proposal(**_proposal_kwargs("ghost"))
    # The defect being fixed: an upsert would have left a row here with no status/created_at.
    assert "Item" not in _raw_table("recon-cases").get_item(Key={"item_id": "ghost"})


@mock_aws
def test_attach_proposal_writes_onto_an_existing_case():
    """The normal path (open() first) still persists every proposal field."""
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)
    cases.attach_proposal(**_proposal_kwargs("i-1"), proposed_action={"reference": "DRAW-1"})
    row = cases.get("i-1")
    assert row["class_id"] == "timing-difference"
    assert row["proposed_action"] == {"reference": "DRAW-1"}
    assert row["status"] == CaseStatus.IN_PROGRESS.value  # untouched by the proposal write


@mock_aws
def test_set_status_refuses_to_create_a_case_row():
    """set_status on an unknown case is a loud KeyError, not a row with only a status."""
    _make_tables()
    cases = _store()
    with pytest.raises(KeyError, match="not found"):
        cases.set_status("ghost", CaseStatus.CLOSED_NO_ACTION, note="cleanup")
    assert "Item" not in _raw_table("recon-cases").get_item(Key={"item_id": "ghost"})
    # A failed status write must not leave a dangling audit row either.
    assert _audit_rows("ghost") == []


@mock_aws
def test_redrive_refuses_an_unknown_case():
    """redrive resets status from terminal states, but only for a case that exists."""
    _make_tables()
    cases = _store()
    with pytest.raises(KeyError, match="not found"):
        cases.redrive(_item("ghost"), reprocess_cap=3)


@mock_aws
def test_audit_ts_is_microsecond_iso_and_sorts_chronologically():
    """ts is a fixed-width microsecond UTC stamp, so string ordering is chronological order."""
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.PENDING, tier=2)
    assert cases.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)
    assert cases.transition("item_id", "i-1", CaseStatus.PROPOSED)
    rows = _audit_rows("i-1")
    stamps = [row["ts"] for row in rows]
    assert [row["status"] for row in rows] == ["PENDING", "IN_PROGRESS", "PROPOSED"]
    assert stamps == sorted(stamps)  # DynamoDB returned them in RANGE-key order
    for stamp in stamps:
        # "2026-08-05T07:17:25.205934" — 26 chars, exactly 6 fractional digits.
        assert len(stamp) == 26, stamp
        assert len(stamp.split(".")[1]) == 6, stamp


@mock_aws
def test_audit_row_never_overwrites_an_existing_row(monkeypatch):
    """Two audit rows written in the same microsecond both survive (append-only trail)."""
    _make_tables()
    cases = _store()
    # Frozen before the first write, so all three rows contend for the same microsecond — the
    # collision path a plain PutItem would silently collapse into one row.
    _freeze_clock(monkeypatch)
    cases.open(_item(), status=CaseStatus.PENDING, tier=2)

    assert cases.transition("item_id", "i-1", CaseStatus.IN_PROGRESS)
    assert cases.transition("item_id", "i-1", CaseStatus.PROPOSED)
    rows = _audit_rows("i-1")
    # The open() row plus both transitions — three distinct rows despite the frozen clock.
    assert [row["status"] for row in rows] == ["PENDING", "IN_PROGRESS", "PROPOSED"]
    assert len({row["ts"] for row in rows}) == 3


@mock_aws
def test_audit_row_raises_when_every_timestamp_is_taken(monkeypatch):
    """Exhausting the collision bumps raises rather than dropping the audit row silently."""
    _make_tables()
    cases = _store()
    _freeze_clock(monkeypatch)
    cases.open(_item(), status=CaseStatus.PENDING, tier=2)  # takes the only available ts

    monkeypatch.setattr("backend.recon_core.cases._AUDIT_TS_ATTEMPTS", 1)

    with pytest.raises(RuntimeError, match="could not write an audit row"):
        cases.set_status("i-1", CaseStatus.IN_PROGRESS)
