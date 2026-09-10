"""What the contacts table does to the interceptor's verdict, over a contact's lifetime.

``test_send_purpose.py`` covers the purpose gate: which branch a send lands in and what each branch
compares. This file covers the consequence of moving both recipient decisions into a table an operator
edits while the system is running. Four things become testable that were not before:

* deactivating somebody REVOKES mail to them, on the next send, with nobody redeploying anything —
  including mail from a draft an analyst already approved, byte for byte unchanged;
* there is no cache, so "the next send" means the next send and not the next TTL expiry;
* an empty list refuses rather than waving everything through;
* a table the interceptor cannot READ has to deny differently from a table that is merely empty,
  because those two send an operator to completely different places.

The last test here guards the property that makes all of this affordable: every read tool and every
non-email tool still reaches its target having done no I/O at all. It is the one test in the file that
would go green on a refactor and still be worth failing — hoisting a contact lookup above the purpose
switch costs a DynamoDB round-trip on every single gateway call the agent makes.
"""

import logging

import boto3
import pytest
from moto import mock_aws

from backend.gateway_interceptor import handler
from backend.gateway_interceptor.handler import handle

CASES_TABLE = "recon-dev-cases"
CONTACTS_TABLE = "recon-dev-contacts"
TOKEN = "secret-tok"  # nosec B105 - test fixture, not a real secret
SEND_TOOL = "microsoft-graph___sendSharedMailboxMail"

NOTIFY_CONTACT_ID = "int-ops"
NOTIFY = "ops@operator.example"
CP_CONTACT_ID = "cp-cindermoor"
COUNTERPARTY = "ap@counterparty.example"
COUNTERPARTY_DOMAIN = "counterparty.example"
APPROVED_SUBJECT = "Wire reference confirmation"
APPROVED_BODY = "Please confirm the reference on the 2026-08-03 wire."


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """A fully configured, enforcing interceptor. No table is created — each test builds its own.

    :param monkeypatch: pytest env patcher.
    :returns: None.
    """
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", TOKEN)
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    monkeypatch.setenv("COUNTERPARTY_EMAIL_DOMAINS", COUNTERPARTY_DOMAIN)
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")


def _event(tool: str, args: dict) -> dict:
    """Wrap a tool call in the interceptor's input envelope.

    :param tool: full gateway tool name.
    :param args: the tool-call arguments.
    :returns: the interceptor input event.
    """
    body = {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    }
    return {"interceptorInputVersion": "1.0", "mcp": {"gatewayRequest": {"body": body}}}


def _send_args(*, recipient: str, purpose: str, **extra) -> dict:
    """A single-recipient Graph sendMail payload carrying a valid confirmation token.

    :param recipient: the sole recipient address.
    :param purpose: the declared ``sendPurpose``.
    :param extra: additional top-level arguments (e.g. ``reconItemId``).
    :returns: the tool-call arguments.
    """
    args = {
        "mailboxAddress": "shared@operator.example",
        "message": {
            "subject": APPROVED_SUBJECT,
            "body": {"contentType": "Text", "content": APPROVED_BODY},
            "toRecipients": [{"emailAddress": {"address": recipient}}],
        },
        "confirmationToken": TOKEN,
        "sendPurpose": purpose,
    }
    args.update(extra)
    return args


def _notification(recipient: str = NOTIFY) -> dict:
    """An internal-notification send event.

    :param recipient: the address the notification is addressed to.
    :returns: the interceptor input event.
    """
    return _event(SEND_TOOL, _send_args(recipient=recipient, purpose="notification"))


def _counterparty(*, item_id: str = "i-1", recipient: str = COUNTERPARTY) -> dict:
    """A counterparty send event citing a case.

    :param item_id: the ``reconItemId`` the send declares.
    :param recipient: the address the send is addressed to.
    :returns: the interceptor input event.
    """
    return _event(
        SEND_TOOL,
        _send_args(recipient=recipient, purpose="counterparty", reconItemId=item_id),
    )


def _passed(out: dict) -> bool:
    """Whether the interceptor forwarded the call rather than short-circuiting it.

    :param out: the interceptor output envelope.
    :returns: True when the request was forwarded to the target.
    """
    return (
        "transformedGatewayRequest" in out["mcp"] and "transformedGatewayResponse" not in out["mcp"]
    )


def _reason(out: dict) -> str:
    """The denial reason the caller receives; fails the test if the send was allowed through.

    :param out: the interceptor output envelope.
    :returns: the denial text.
    """
    assert not _passed(out), "expected a rejection, but the send was forwarded to Graph"
    result = out["mcp"]["transformedGatewayResponse"]["body"]["result"]
    assert result["isError"] is True
    return result["content"][0]["text"]


def _contacts_table():
    """Create an EMPTY contacts table and return it, so each test states its own rows.

    :returns: the moto DynamoDB Table for recon-contacts.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CONTACTS_TABLE,
        KeySchema=[{"AttributeName": "contact_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "contact_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb.Table(CONTACTS_TABLE)


def _put_contact(table, *, contact_id: str, email: str, kind: str, active: bool = True) -> None:
    """Write one contact row.

    :param table: the contacts Table.
    :param contact_id: the row key.
    :param email: the stored address.
    :param kind: ``counterparty`` or ``internal_notification``.
    :param active: whether the contact may currently be sent to.
    :returns: None.
    """
    table.put_item(
        Item={
            "contact_id": contact_id,
            "display_name": contact_id,
            "email": email,
            "kind": kind,
            "active": active,
        }
    )


def _cases_table():
    """Create the cases table.

    :returns: the moto DynamoDB Table for recon-cases.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CASES_TABLE,
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb.Table(CASES_TABLE)


def _seed_approved_draft(table, *, item_id: str = "i-1", contact_id: str = CP_CONTACT_ID) -> None:
    """Put a case carrying an approved draft at its approved revision.

    :param table: the cases Table.
    :param item_id: the case key.
    :param contact_id: the contact the draft cites.
    :returns: None.
    """
    table.put_item(
        Item={
            "item_id": item_id,
            "status": "PROPOSED",
            "proposed_email": {
                "recipient": None,
                "recipient_contact_id": contact_id,
                "recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.",
                "subject": APPROVED_SUBJECT,
                "body": APPROVED_BODY,
                "draft_status": "approved",
                "revision": 2,
                "approved_revision": 2,
            },
        }
    )


# --- notification: the operator's list is the whole authorization -------------------------------


@mock_aws
def test_an_active_internal_contact_may_receive_a_notification():
    contacts = _contacts_table()
    _put_contact(contacts, contact_id=NOTIFY_CONTACT_ID, email=NOTIFY, kind="internal_notification")
    assert _passed(handle(_notification()))


@mock_aws
def test_an_empty_contacts_table_refuses_every_notification():
    """A system with nobody on the list has nobody it is entitled to email.

    The tempting reading of an empty list is "no restriction configured, so no restriction applies",
    which is how an allowlist becomes decoration. Same fail-closed direction as an empty counterparty
    domain allowlist.
    """
    _contacts_table()
    assert "no active internal_notification contact is configured" in _reason(
        handle(_notification())
    )


@mock_aws
def test_deactivating_a_contact_takes_effect_on_the_very_next_send():
    """Two calls, one deactivation in between, no process restart — and no TTL to wait out.

    This is the test that would fail if anyone put a cache in front of the contacts read for the
    obvious performance reason. "We stopped emailing them within five minutes" is not what an operator
    means when they deactivate a leaver, and the window would be invisible in every other test here.

    A SECOND contact stays active throughout, so the list is never empty. Deactivating the only row
    would refuse via the empty-list branch instead — the right outcome, but not the one under test, and
    the test would then pass even if the per-recipient check were deleted.
    """
    contacts = _contacts_table()
    _put_contact(contacts, contact_id=NOTIFY_CONTACT_ID, email=NOTIFY, kind="internal_notification")
    _put_contact(
        contacts,
        contact_id="int-treasury",
        email="treasury@operator.example",
        kind="internal_notification",
    )
    assert _passed(handle(_notification()))

    contacts.update_item(
        Key={"contact_id": NOTIFY_CONTACT_ID},
        UpdateExpression="SET active = :f",
        ExpressionAttributeValues={":f": False},
    )
    assert "is not an active internal_notification contact" in _reason(handle(_notification()))


@mock_aws
def test_an_unreadable_contacts_table_denies_with_the_error_not_with_an_empty_list(monkeypatch):
    """Both fail closed. They must not fail closed with the SAME message.

    A mis-scoped IAM grant reported as "no active internal_notification contact is configured" sends
    the operator to the Config tab to add a contact that is already sitting there. So the denial names
    the exception instead — the empty-list wording is reserved for a list that is genuinely empty.
    """
    _contacts_table()

    def _explode(*_args, **_kwargs):
        raise RuntimeError("AccessDeniedException: not authorized to perform dynamodb:Scan")

    monkeypatch.setattr(handler.boto3, "resource", _explode)
    reason = _reason(handle(_notification()))
    assert "sendPurpose check failed: RuntimeError" in reason
    assert "AccessDeniedException" in reason
    assert "no active internal_notification contact" not in reason


# --- counterparty: deactivation revokes an approved draft ----------------------------------------


@mock_aws
def test_deactivating_a_counterparty_revokes_an_already_approved_draft():
    """The send is byte-identical to the one that passed a moment ago. Only the contact row changed.

    This is the whole reason a draft stores a contact id rather than an address: revocation needs no
    edit to the case, no re-approval, and no second copy of the recipient anywhere. An address stored
    on the draft would still be sitting there, approved, matching, and sendable.
    """
    cases = _cases_table()
    contacts = _contacts_table()
    _seed_approved_draft(cases)
    _put_contact(contacts, contact_id=CP_CONTACT_ID, email=COUNTERPARTY, kind="counterparty")
    assert _passed(handle(_counterparty()))

    contacts.update_item(
        Key={"contact_id": CP_CONTACT_ID},
        UpdateExpression="SET active = :f",
        ExpressionAttributeValues={":f": False},
    )
    reason = _reason(handle(_counterparty()))
    assert "cannot resolve the approved draft's recipient" in reason
    assert "deactivated" in reason


@mock_aws
def test_a_draft_holding_a_literal_address_instead_of_a_contact_id_cannot_send():
    """A draft carrying a literal address and no contact id, refused rather than honoured.

    Falling back to the payload's address for a draft with no ``recipient_contact_id`` would authorize
    whatever the caller asked for — which is precisely the check this branch exists to be. Refusing
    costs nothing: such a draft is re-editable, and being told to pick a recipient is a better outcome
    than an unverifiable send.
    """
    cases = _cases_table()
    _contacts_table()
    cases.put_item(
        Item={
            "item_id": "i-old",
            "status": "PROPOSED",
            "proposed_email": {
                # An address and no contact id at all, so nothing here is resolvable.
                "recipient": COUNTERPARTY,
                "subject": APPROVED_SUBJECT,
                "body": APPROVED_BODY,
                "draft_status": "approved",
                "revision": 2,
                "approved_revision": 2,
            },
        }
    )
    out = handle(_counterparty(item_id="i-old"))
    assert "the approved draft cites no recipient_contact_id" in _reason(out)


@mock_aws
def test_a_notification_contact_cannot_be_reached_down_the_counterparty_path():
    """The kinds are disjoint in both directions, and the draft citing the id does not change that."""
    cases = _cases_table()
    contacts = _contacts_table()
    _seed_approved_draft(cases, contact_id=NOTIFY_CONTACT_ID)
    # Deliberately given an in-allowlist address, so the allowlist cannot be what refuses this.
    _put_contact(
        contacts,
        contact_id=NOTIFY_CONTACT_ID,
        email=COUNTERPARTY,
        kind="internal_notification",
    )
    reason = _reason(handle(_counterparty()))
    assert "cannot satisfy a 'counterparty' send" in reason


# --- the property that makes the two reads affordable --------------------------------------------


@pytest.mark.parametrize(
    "tool, args",
    [
        (
            "microsoft-graph___listSharedMailboxMessages",
            {"mailboxAddress": "s@x.com", "$top": "10"},
        ),
        ("correspondence-search___search_correspondence", {"query": "wire"}),
        ("recon-ledger___search_ledger", {"query": "invoice 42"}),
        ("notices___search_notices", {"query": "shortpay"}),
        ("contacts___list_contacts", {"kind": "counterparty"}),
        ("templates___list_templates", {}),
        ("x_amz_bedrock_agentcore_search", {"query": "anything"}),
    ],
)
def test_no_dynamodb_call_is_made_for_a_read_tool(monkeypatch, caplog, tool, args):
    """Every read tool reaches its target having done no I/O at all — including the two contact reads.

    ``boto3.resource`` is replaced by something that raises AND records, so the assertion is on the
    recording rather than on an exception: ``_handle_read`` deliberately swallows failures and forwards
    anyway, so an exception alone would prove nothing about whether a round-trip was attempted.

    The reason to pin this is a refactor that reads perfectly well in review: hoist the contact lookup
    out of the purpose switch to "resolve the recipient once, up front". Every send test would still
    pass, and every one of the agent's hundreds of read calls would grow a DynamoDB Scan in front of it.
    """
    seen: list[tuple] = []

    def _record_and_explode(*a, **kw):
        seen.append((a, kw))
        raise AssertionError(f"{tool} attempted a boto3 client for {a!r}")

    monkeypatch.setattr(handler.boto3, "resource", _record_and_explode)
    with caplog.at_level(logging.WARNING, logger="backend.gateway_interceptor.handler"):
        out = handle(_event(tool, args))

    assert seen == []
    assert _passed(out)


def test_a_non_tool_call_message_does_no_io_either(monkeypatch):
    """The fast path: initialize, tools/list, notifications. Not a tool call, so not the gate's business."""
    seen: list[tuple] = []
    monkeypatch.setattr(handler.boto3, "resource", lambda *a, **kw: seen.append(a))
    out = handle(
        {
            "interceptorInputVersion": "1.0",
            "mcp": {
                "gatewayRequest": {
                    "body": {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
                }
            },
        }
    )
    assert seen == []
    assert _passed(out)
