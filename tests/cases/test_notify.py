"""Tests for the Microsoft Graph (gateway tool) resolution-email notifier."""

import pytest

from backend.cases.notify import SEND_MAIL_TOOL, send_resolution_email
from backend.recon_core.gateway_client import mcp_endpoint


def test_send_resolution_email_calls_graph_gateway_tool():
    """The notifier calls sendSharedMailboxMail with the Graph message shape."""
    calls: list[tuple[str, dict]] = []

    def transport(tool_name: str, arguments: dict) -> dict:
        calls.append((tool_name, arguments))
        return {"content": []}

    case = {"item_id": "idp-1", "domain": "cash", "class_id": "timing",
            "resolution": "apply to fund X", "confidence": "0.83"}
    ack = send_resolution_email(
        case, mailbox="shared@recon.example", recipient="ops@recon.example",
        transport=transport,
    )

    assert ack == "graph-send:idp-1"
    assert len(calls) == 1
    tool_name, args = calls[0]
    assert tool_name == SEND_MAIL_TOOL == "microsoft-graph___sendSharedMailboxMail"
    # Sent FROM the shared mailbox, TO the configured recipient.
    assert args["mailboxAddress"] == "shared@recon.example"
    to = args["message"]["toRecipients"]
    assert to == [{"emailAddress": {"address": "ops@recon.example"}}]
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
        recipient="ops@recon.example",
        transport=transport,
    )

    assert captured["sendPurpose"] == "notification"
    assert captured["confirmationToken"] == "tok"
    # ...and the recipient is the single address the interceptor will compare against
    # RECON_NOTIFY_EMAIL. Two recipients would make that comparison meaningless, so the notifier
    # must never grow a second one.
    assert len(captured["message"]["toRecipients"]) == 1


def test_send_resolution_email_raises_on_gateway_failure():
    """Approve path is fail-loud: a transport error propagates to the caller."""

    def transport(tool_name: str, arguments: dict) -> dict:
        raise RuntimeError("gateway tools/call failed: AccessDenied")

    case = {"item_id": "idp-1", "domain": "cash", "resolution": "x", "confidence": "0.5"}
    with pytest.raises(RuntimeError, match="AccessDenied"):
        send_resolution_email(
            case, mailbox="shared@x.com", recipient="to@x.com", transport=transport
        )


def test_mcp_endpoint_suffix_is_idempotent():
    """GetGateway returns the bare host; /mcp is appended exactly once."""
    bare = "https://gw1.gateway.bedrock-agentcore.us-east-1.amazonaws.com"
    assert mcp_endpoint(bare) == f"{bare}/mcp"
    assert mcp_endpoint(f"{bare}/mcp") == f"{bare}/mcp"
    assert mcp_endpoint(f"{bare}/") == f"{bare}/mcp"
