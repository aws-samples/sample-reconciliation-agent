"""Tests for the Microsoft Graph (gateway tool) resolution-email notifier.

Every case here needs moto, because the notifier is handed a CONTACT ID and looks the address up
itself. That indirection is the thing under test as much as the Graph message shape is: an operator
who deactivates a recipient in the console expects the next resolution not to mail them, and the only
mechanism delivering that is this lookup happening on every send rather than at deploy time.
"""

import boto3
import pytest
from moto import mock_aws

from backend.cases.notify import SEND_MAIL_TOOL, send_resolution_email
from backend.recon_core.gateway_client import mcp_endpoint

CONTACTS_TABLE = "recon-dev-contacts"
CONTACT_ID = "int-ops"
NOTIFY = "ops@recon.example"


@pytest.fixture(autouse=True)
def _contacts_table(monkeypatch):
    """Point the notifier at a moto contacts table holding one active internal contact.

    ``autouse`` because the notifier resolves the address before it builds anything, so a test that
    forgot this fixture would fail on the lookup rather than on its own subject.

    :param monkeypatch: pytest env patcher.
    :returns: the moto DynamoDB Table, so a test can deactivate or replace the seeded contact.
    """
    with mock_aws():
        monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName=CONTACTS_TABLE,
            KeySchema=[{"AttributeName": "contact_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "contact_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table = ddb.Table(CONTACTS_TABLE)
        table.put_item(
            Item={
                "contact_id": CONTACT_ID,
                "display_name": "Reconciliation Operations",
                "email": NOTIFY,
                "kind": "internal_notification",
                "active": True,
            }
        )
        yield table


def test_send_resolution_email_calls_graph_gateway_tool():
    """The notifier calls sendSharedMailboxMail with the Graph message shape."""
    calls: list[tuple[str, dict]] = []

    def transport(tool_name: str, arguments: dict) -> dict:
        calls.append((tool_name, arguments))
        return {"content": []}

    case = {
        "item_id": "idp-1",
        "domain": "cash",
        "class_id": "timing",
        "resolution": "apply to fund X",
        "confidence": "0.83",
    }
    ack = send_resolution_email(
        case,
        mailbox="shared@recon.example",
        contact_id=CONTACT_ID,
        transport=transport,
    )

    assert ack == "graph-send:idp-1"
    assert len(calls) == 1
    tool_name, args = calls[0]
    assert tool_name == SEND_MAIL_TOOL == "microsoft-graph___sendSharedMailboxMail"
    # Sent FROM the shared mailbox, TO the address the contact row carries — the caller never named
    # an address, so this assertion is also what proves the resolution happened.
    assert args["mailboxAddress"] == "shared@recon.example"
    to = args["message"]["toRecipients"]
    assert to == [{"emailAddress": {"address": NOTIFY}}]
    assert args["saveToSentItems"] is True
    # Subject/body carry the case facts (unchanged from the SES-era text).
    assert args["message"]["subject"] == "[Recon] Resolved: idp-1 (cash)"
    body = args["message"]["body"]
    assert body["contentType"] == "Text"
    for fragment in ("cash", "timing", "apply to fund X", "0.83"):
        assert fragment in body["content"]


def test_the_notification_declares_its_send_purpose(monkeypatch):
    """Required, not incidental: the interceptor denies a send whose purpose is absent.

    Asserted as its own test rather than one more line in the shape test above, because dropping
    this field breaks the send in production while every shape assertion still passes.
    """
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", "tok")
    captured: dict = {}

    def transport(tool_name: str, arguments: dict) -> dict:
        captured.update(arguments)
        return {"content": []}

    send_resolution_email(
        {"item_id": "idp-1", "domain": "cash", "resolution": "x", "confidence": "0.5"},
        mailbox="shared@recon.example",
        contact_id=CONTACT_ID,
        transport=transport,
    )

    assert captured["sendPurpose"] == "notification"
    assert captured["confirmationToken"] == "tok"
    # ...and the recipient is the single address the interceptor will check against the active
    # internal_notification contacts. Two recipients would make "the recipient is on the list" stop
    # being a statement about who receives the mail, so the notifier must never grow a second one.
    assert len(captured["message"]["toRecipients"]) == 1


def test_a_deactivated_contact_raises_before_anything_is_sent(_contacts_table):
    """Deactivation must stop the mail here, not merely be denied later at the gateway.

    Both layers refuse — but only this one refuses without a Graph round-trip, and the caller needs a
    ``LookupError`` it can name in a log line rather than an opaque gateway rejection.
    """
    _contacts_table.update_item(
        Key={"contact_id": CONTACT_ID},
        UpdateExpression="SET active = :f",
        ExpressionAttributeValues={":f": False},
    )
    sent: list[dict] = []

    def transport(tool_name: str, arguments: dict) -> dict:
        sent.append(arguments)
        return {"content": []}

    with pytest.raises(LookupError, match="deactivated"):
        send_resolution_email(
            {"item_id": "idp-1", "domain": "cash", "resolution": "x", "confidence": "0.5"},
            mailbox="shared@recon.example",
            contact_id=CONTACT_ID,
            transport=transport,
        )
    assert sent == []


def test_a_counterparty_contact_cannot_be_used_as_a_notification_recipient(_contacts_table):
    """The kind check is what keeps internal status mail internal.

    A live counterparty contact is a perfectly valid, active row — so an id typo in
    ``NOTIFY_CONTACT_ID`` that happened to name one would otherwise mail case ids, resolutions and
    confidence scores to a party outside the operator.
    """
    _contacts_table.put_item(
        Item={
            "contact_id": "cp-1",
            "display_name": "CINDERMOOR LOGISTICS HOLDINGS INC.",
            "email": "ap@counterparty.example",
            "kind": "counterparty",
            "active": True,
        }
    )
    with pytest.raises(LookupError, match="kind"):
        send_resolution_email(
            {"item_id": "idp-1", "domain": "cash", "resolution": "x", "confidence": "0.5"},
            mailbox="shared@recon.example",
            contact_id="cp-1",
            transport=lambda tool_name, arguments: {"content": []},
        )


def test_send_resolution_email_raises_on_gateway_failure():
    """Approve path is fail-loud: a transport error propagates to the caller."""

    def transport(tool_name: str, arguments: dict) -> dict:
        raise RuntimeError("gateway tools/call failed: AccessDenied")

    case = {"item_id": "idp-1", "domain": "cash", "resolution": "x", "confidence": "0.5"}
    with pytest.raises(RuntimeError, match="AccessDenied"):
        send_resolution_email(
            case, mailbox="shared@x.com", contact_id=CONTACT_ID, transport=transport
        )


def test_mcp_endpoint_suffix_is_idempotent():
    """GetGateway returns the bare host; /mcp is appended exactly once."""
    bare = "https://gw1.gateway.bedrock-agentcore.us-east-1.amazonaws.com"
    assert mcp_endpoint(bare) == f"{bare}/mcp"
    assert mcp_endpoint(f"{bare}/mcp") == f"{bare}/mcp"
    assert mcp_endpoint(f"{bare}/") == f"{bare}/mcp"
