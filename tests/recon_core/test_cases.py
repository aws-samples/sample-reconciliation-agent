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
        "classification_reasoning": "value dates differ by one business day",
        "resolution": "monitor",
        "confidence": Decimal("0.8"),
        "steps": [{"skill": "timing"}],
        # Required keywords, no defaults — see cases.attach_proposal. None is legal for both.
        "notice_search": None,
        "token_usage": None,
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
def test_attach_proposal_writes_no_classification_confidence() -> None:
    """A stored number nobody computes and no screen renders is worse than absent.

    The next reader assumes it means something. The only confidence on a case is ``confidence`` —
    the evidence-completeness score computed by ``recon_core.confidence.score_proposal``. Nothing
    backfills or strips the attribute on rows that already carry it, so the write path is the only
    place this can be held.

    :returns: None.
    """
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)
    cases.attach_proposal(**_proposal_kwargs("i-1"))
    row = _raw_table("recon-cases").get_item(Key={"item_id": "i-1"})["Item"]
    assert "classification_confidence" not in row
    assert row["confidence"] == Decimal("0.8")


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
def test_mark_failed_writes_status_reason_and_timestamp_together():
    """FAILED, the reason and the failure time land in ONE write, plus an audit row.

    Splitting the write would leave a window where the case reads FAILED with no reason — which is
    precisely the information the analyst needs in order to decide whether to retry.
    """
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)

    assert cases.mark_failed("i-1", reason="MaxTokensReachedException: output cap hit")

    row = cases.get("i-1")
    assert row["status"] == CaseStatus.FAILED.value
    assert row["failure_reason"] == "MaxTokensReachedException: output cap hit"
    assert row["failed_at"]
    # created_at is the status-index RANGE key; a FAILED case must stay queryable from the GSI.
    assert row["created_at"]
    assert [r["status"] for r in _audit_rows("i-1")] == ["IN_PROGRESS", "FAILED"]


@mock_aws
def test_mark_failed_never_overwrites_a_case_that_already_reached_a_verdict():
    """A run that persisted its proposal and then errored on the way out keeps the proposal.

    The proposal is the real result; recording the trailing error as a failure would throw away work
    the analyst can act on and put the case back in the retry queue for nothing.
    """
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)
    assert cases.transition("item_id", "i-1", CaseStatus.PROPOSED)

    assert cases.mark_failed("i-1", reason="boom on the way out") is False

    row = cases.get("i-1")
    assert row["status"] == CaseStatus.PROPOSED.value
    assert "failure_reason" not in row


@mock_aws
def test_mark_failed_refuses_an_unknown_case():
    """A failure for an item with no case row raises rather than upserting a statusless orphan."""
    _make_tables()
    cases = _store()
    with pytest.raises(KeyError, match="not found"):
        cases.mark_failed("ghost", reason="boom")
    assert "Item" not in _raw_table("recon-cases").get_item(Key={"item_id": "ghost"})


@mock_aws
def test_mark_failed_truncates_a_huge_reason_and_says_so():
    """Reasons come from exception text; the case row is read on every queue render."""
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)

    assert cases.mark_failed("i-1", reason="x" * 5000)

    stored = cases.get("i-1")["failure_reason"]
    assert len(stored) < 1000
    assert stored.endswith("(truncated, see worker logs)")


@mock_aws
def test_mark_failed_records_something_when_the_error_had_no_text():
    """An empty reason must not persist as an empty panel that reads like a rendering bug."""
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)

    assert cases.mark_failed("i-1", reason="   ")

    assert cases.get("i-1")["failure_reason"] == "investigation failed with no error text"


@mock_aws
def test_a_failed_case_can_be_retried_back_into_progress():
    """The retry path an analyst drives: FAILED -> IN_PROGRESS through the guarded transition."""
    _make_tables()
    cases = _store()
    cases.open(_item(), status=CaseStatus.IN_PROGRESS, tier=2)
    assert cases.mark_failed("i-1", reason="boom")

    assert cases.transition("item_id", "i-1", CaseStatus.IN_PROGRESS, note="analyst: retry")

    assert cases.get("i-1")["status"] == CaseStatus.IN_PROGRESS.value
    assert [r["status"] for r in _audit_rows("i-1")] == [
        "IN_PROGRESS",
        "FAILED",
        "IN_PROGRESS",
    ]


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


@mock_aws
def test_open_omits_tier1_match_entirely_when_there_is_none():
    """No evidence means no attribute, so escalated and pre-existing cases stay byte-identical.

    Writing an empty map instead would make "Tier-1 recorded nothing" indistinguishable from
    "Tier-1 measured nothing", and the case screen has to tell those apart.
    """
    _make_tables()
    _store().open(_item("i-none"), status=CaseStatus.PENDING, tier=2)
    row = _raw_table("recon-cases").get_item(Key={"item_id": "i-none"})["Item"]
    assert "tier1_match" not in row
    assert "category" not in row


@mock_aws
def test_open_persists_tier1_match_as_a_top_level_attribute():
    """Tier-1's finding is an output about the item, not part of the item as it arrived.

    Keeping it out of ``item.attributes`` matters because that bag is replayed as the extraction
    input; a derived verdict living inside it would look like something the source document said.
    """
    _make_tables()
    evidence = {
        "matched_on": "rule",
        "match_attr": "amount",
        "tolerance": "0.05",
        "side_a_value": "100.00",
        "side_b_value": "100.02",
        "difference": "0.02",
    }
    _store().open(
        _item("i-ev"),
        status=CaseStatus.AUTO_CLEARED,
        tier=1,
        category="amount-match",
        tier1_match=evidence,
    )
    row = _raw_table("recon-cases").get_item(Key={"item_id": "i-ev"})["Item"]
    assert row["tier1_match"] == evidence
    assert "tier1_match" not in row["item"]["attributes"]
