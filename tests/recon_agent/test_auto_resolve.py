"""Tests for the auto-resolve path (composite confidence >= admin threshold)."""

import logging

import boto3
from moto import mock_aws

from backend.recon_core.auto_resolve import get_threshold, maybe_auto_resolve

from backend.recon_core.cases import CaseStore
from backend.recon_core.email_policy import build_persisted_draft
from backend.recon_core.schema import Proposal, ReconItem
from backend.recon_core.status import CaseStatus

CONTACTS_TABLE = "recon-contacts"
NOTIFY_CONTACT_ID = "int-ops"
NOTIFY = "ops@recon.example"


class _Templates:
    """A TemplateStore stand-in for the one test here that needs a draft to exist.

    What the draft SAYS is irrelevant to auto-resolution — only that the case carries one — so this
    returns a fixed template rather than reaching for the real table.
    """

    def get(self, *, template_id: str) -> dict:
        """Return a template with no variables to substitute.

        :param template_id: the id the draft cited; ignored.
        :returns: a fixed subject/body pair.
        """
        return {
            "subject_template": "Wire reference confirmation",
            "body_template": "Please confirm.",
            "variables": [],
        }


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
    # The notification recipient lives here, not in an environment variable — auto-resolve names a
    # contact id and the notifier looks the address up when it sends. Created unconditionally so a test
    # that only cares about the status transitions does not have to know that.
    ddb.create_table(
        TableName=CONTACTS_TABLE,
        KeySchema=[{"AttributeName": "contact_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "contact_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table(CONTACTS_TABLE).put_item(
        Item={
            "contact_id": NOTIFY_CONTACT_ID,
            "display_name": "Reconciliation Operations",
            "email": NOTIFY,
            "kind": "internal_notification",
            "active": True,
        }
    )


def _notify_env(monkeypatch) -> None:
    """Configure the auto-resolve notification: a shared mailbox to send FROM and a contact to send TO.

    :param monkeypatch: pytest env patcher.
    :returns: None.
    """
    monkeypatch.setenv("GRAPH_MAILBOX", "shared@recon.example")
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    monkeypatch.setenv("NOTIFY_CONTACT_ID", NOTIFY_CONTACT_ID)


def _proposed_case(cases: CaseStore, item_id: str = "i-1") -> Proposal:
    item = ReconItem(item_id=item_id, domain="cash", sides=[])
    cases.open(item, status=CaseStatus.PENDING, tier=2)
    cases.transition("item_id", item_id, CaseStatus.IN_PROGRESS)
    cases.transition("item_id", item_id, CaseStatus.PROPOSED)
    return Proposal(
        item_id=item_id,
        class_id="timing",
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
    """With a mailbox and a notify contact set, the notification goes out via the Graph gateway tool."""
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    _notify_env(monkeypatch)
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
    # The address came out of the contact row; nothing in the environment named it.
    assert args["message"]["toRecipients"][0]["emailAddress"]["address"] == NOTIFY
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
    _notify_env(monkeypatch)
    calls: list[tuple[str, dict]] = []

    def transport(tool_name: str, arguments: dict) -> dict:
        calls.append((tool_name, arguments))
        return {"content": []}

    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    prop.confidence = 1.0
    # Built through the real helper rather than hand-rolled, so a change to the persisted shape
    # cannot leave this test asserting against a draft the code does not produce.
    prop.proposed_email = build_persisted_draft(
        email_draft={
            "recipient_contact_id": "cp-acme",
            "template_id": "tpl-wire",
            "variables": {},
        },
        templates=_Templates(),
    )
    assert (
        maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.5, transport=transport) is False
    )
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
    _notify_env(monkeypatch)

    def transport(tool_name: str, arguments: dict) -> dict:
        raise RuntimeError("gateway unreachable")

    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    assert maybe_auto_resolve(cases=cases, proposal=prop, threshold=0.95, transport=transport)
    assert cases.status("i-1") == CaseStatus.RESOLVED


@mock_aws
def test_auto_resolve_skips_the_email_when_the_notify_contact_is_deactivated_but_still_resolves(
    monkeypatch, caplog
):
    """Deactivating the notify contact must not quietly stop cases from resolving.

    The recipient is a contact row an operator can deactivate at any time — somebody removes a leaver
    from the Config tab — so it can stop being valid between one case and the next. The resolution has
    to survive that, because a case whose evidence cleared the threshold is resolved whether or not
    anyone was told.

    The log assertion is the other half. Best-effort silence is exactly how "we stopped getting
    resolution emails last Tuesday" turns into an afternoon of guessing, so the warning has to name the
    contact id that failed.
    """
    _make_tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    _notify_env(monkeypatch)
    boto3.resource("dynamodb", region_name="us-east-1").Table(CONTACTS_TABLE).update_item(
        Key={"contact_id": NOTIFY_CONTACT_ID},
        UpdateExpression="SET active = :f",
        ExpressionAttributeValues={":f": False},
    )
    calls: list[str] = []

    cases = CaseStore(table="recon-cases", audit="recon-audit")
    prop = _proposed_case(cases)
    with caplog.at_level(logging.WARNING, logger="backend.recon_core.auto_resolve"):
        assert maybe_auto_resolve(
            cases=cases,
            proposal=prop,
            threshold=0.95,
            transport=lambda tool_name, arguments: calls.append(tool_name) or {"content": []},
        )

    assert cases.status("i-1") == CaseStatus.RESOLVED
    # Refused before the gateway was touched, not after — nothing was sent anywhere.
    assert calls == []
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert NOTIFY_CONTACT_ID in messages
    assert "deactivated" in messages
