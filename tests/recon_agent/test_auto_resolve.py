"""Tests for the auto-resolve path (composite confidence >= admin threshold)."""

import boto3
from moto import mock_aws

from backend.recon_core.auto_resolve import get_threshold, maybe_auto_resolve

from backend.recon_core.cases import CaseStore
from backend.recon_core.email_policy import build_persisted_draft
from backend.recon_core.schema import Proposal, ReconItem
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
    ddb.create_table(
        TableName="recon-lessons",
        KeySchema=[{"AttributeName": "lesson_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "lesson_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _proposed_case(cases: CaseStore, item_id: str = "i-1") -> Proposal:
    item = ReconItem(item_id=item_id, domain="cash", sides=[])
    cases.open(item, status=CaseStatus.PENDING, tier=2)
    cases.transition("item_id", item_id, CaseStatus.IN_PROGRESS)
    cases.transition("item_id", item_id, CaseStatus.PROPOSED)
    return Proposal(
        item_id=item_id,
        class_id="timing",
        classification_confidence=0.9,
        classification_reasoning="r",
        resolution="match to bank line 12",
        confidence=0.97,
    )


@mock_aws
def test_above_threshold_resolves_with_lesson(monkeypatch):
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    done = maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.95)
    assert done is True
    assert cases.status("i-1") == CaseStatus.RESOLVED
    # AUTO_RESOLVED lesson recorded for the audit trail / future recall.
    lessons = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-lessons").scan()
    assert lessons["Count"] == 1
    assert lessons["Items"][0]["trigger"] == "AUTO_RESOLVED"


@mock_aws
def test_below_threshold_stays_proposed(monkeypatch):
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    prop.confidence = 0.80
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.95) is False
    assert cases.status("i-1") == CaseStatus.PROPOSED


@mock_aws
def test_disabled_threshold_never_resolves(monkeypatch):
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=None) is False
    assert cases.status("i-1") == CaseStatus.PROPOSED


def test_get_threshold_parses_and_disables():
    class _Ssm:
        def __init__(self, value):
            self._v = value

        def get_parameter(self, Name):
            return {"Parameter": {"Value": self._v}}

    assert get_threshold("p", ssm=_Ssm("0.95")) == 0.95
    assert get_threshold("p", ssm=_Ssm("off")) is None
    assert get_threshold("p", ssm=_Ssm("not-a-number")) is None
    assert get_threshold("", ssm=_Ssm("0.9")) is None  # no param configured


@mock_aws
def test_auto_resolve_sends_graph_email_when_configured(monkeypatch):
    """With mailbox + recipient set, the notification goes out via the Graph gateway tool."""
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    monkeypatch.setenv("GRAPH_MAILBOX", "shared@recon.example")
    monkeypatch.setenv("RECON_NOTIFY_EMAIL", "ops@recon.example")
    calls: list[tuple[str, dict]] = []

    def transport(tool_name: str, arguments: dict) -> dict:
        calls.append((tool_name, arguments))
        return {"content": []}

    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.95, transport=transport)
    assert cases.status("i-1") == CaseStatus.RESOLVED
    assert len(calls) == 1
    tool_name, args = calls[0]
    assert tool_name == "microsoft-graph___sendSharedMailboxMail"
    assert args["mailboxAddress"] == "shared@recon.example"
    assert args["message"]["toRecipients"][0]["emailAddress"]["address"] == "ops@recon.example"
    # Marked as automatic in the subject-driving class field.
    assert "(AUTO-RESOLVED)" in args["message"]["body"]["content"]


@mock_aws
def test_a_case_carrying_an_email_draft_is_never_auto_resolved(monkeypatch):
    """RESOLVED is terminal, so auto-resolving a case with an unsent counterparty draft would
    strand the draft permanently unsendable while the case reads as successfully closed. Confidence
    1.0 against a 0.5 threshold: the ONLY thing holding this case back is the draft.

    Asserted on the transport mock as well as the return value — a bug that resolved the case but
    happened to skip the notification would still pass a status-only assertion, and the notification
    is the operator's signal that the case closed."""
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    monkeypatch.setenv("GRAPH_MAILBOX", "shared@recon.example")
    monkeypatch.setenv("RECON_NOTIFY_EMAIL", "ops@recon.example")
    calls: list[tuple[str, dict]] = []

    def transport(tool_name: str, arguments: dict) -> dict:
        calls.append((tool_name, arguments))
        return {"content": []}

    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    prop.confidence = 1.0
    prop.proposed_email = build_persisted_draft(
        email_draft={"subject": "Wire reference confirmation", "body": "Please confirm."}
    )
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.5, transport=transport) is False
    # Stopped BEFORE the first transition, so the case is still waiting for the analyst.
    assert cases.status("i-1") == CaseStatus.PROPOSED
    assert calls == []
    # No AUTO_RESOLVED lesson either — nothing was resolved to learn from.
    lessons = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-lessons").scan()
    assert lessons["Count"] == 0


@mock_aws
def test_the_same_case_without_the_draft_does_auto_resolve(monkeypatch):
    """The control for the test above: identical confidence and threshold, draft removed. Without
    this, a bug that broke auto-resolution outright would make the refusal test pass for the wrong
    reason."""
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    prop.confidence = 1.0
    assert prop.proposed_email is None
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.5) is True
    assert cases.status("i-1") == CaseStatus.RESOLVED


@mock_aws
def test_auto_resolve_email_failure_does_not_block_resolution(monkeypatch):
    """The notification is best-effort on the autonomous path — a send failure still resolves."""
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    monkeypatch.setenv("GRAPH_MAILBOX", "shared@recon.example")
    monkeypatch.setenv("RECON_NOTIFY_EMAIL", "ops@recon.example")

    def transport(tool_name: str, arguments: dict) -> dict:
        raise RuntimeError("gateway unreachable")

    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.95, transport=transport)
    assert cases.status("i-1") == CaseStatus.RESOLVED
