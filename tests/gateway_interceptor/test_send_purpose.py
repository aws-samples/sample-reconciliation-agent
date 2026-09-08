"""The interceptor's ``sendPurpose`` gate, enforced.

Every case pins the verdict the CALLER receives: an unauthorized shape comes back as a rejection
carrying its reason, not as a log line only an operator would ever read. The two authorized shapes —
a notification to one of the operator's own people, and a counterparty send matching an approved
draft — assert a pass-through, because a gate that denies everything is not a working gate.

Both purposes resolve the recipient out of the contacts table, so nearly every case here needs moto.
What that table does to the verdict over a contact's lifetime — deactivation revoking an approved draft, an unreadable table
denying differently from an empty one — lives in ``test_notification_contact.py``; this file covers
the purpose gate itself.

``log`` mode is covered explicitly rather than by parametrizing every case: its contract is that it
evaluates the same verdict and forwards anyway, and one test can establish that.
"""

import logging

import boto3
import pytest
from moto import mock_aws

from backend.gateway_interceptor.handler import handle

CASES_TABLE = "recon-dev-cases"
CONTACTS_TABLE = "recon-dev-contacts"
CONTACT_ID = "cp-cindermoor"
TOKEN = "secret-tok"  # nosec B105 - test fixture, not a real secret
# An address the operator's own people receive at, reachable only because an ACTIVE
# `internal_notification` contact row carries it. No environment variable is consulted.
NOTIFY_CONTACT_ID = "int-ops"
NOTIFY = "ops@operator.example"
SEND_TOOL = "microsoft-graph___sendSharedMailboxMail"

APPROVED_SUBJECT = "Wire reference confirmation"
APPROVED_BODY = "Please confirm the reference on the 2026-08-03 wire."
COUNTERPARTY = "ap@counterparty.example"
COUNTERPARTY_DOMAIN = "counterparty.example"


def _event(args: dict) -> dict:
    body = {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": SEND_TOOL, "arguments": args},
    }
    return {"interceptorInputVersion": "1.0", "mcp": {"gatewayRequest": {"body": body}}}


def _args(
    *,
    recipients: list[str],
    subject: str = APPROVED_SUBJECT,
    body: str = APPROVED_BODY,
    **extra,
) -> dict:
    args = {
        "mailboxAddress": "shared@operator.example",
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": a}} for a in recipients],
        },
        "confirmationToken": TOKEN,
    }
    args.update(extra)
    return args


def _passed(out: dict) -> bool:
    return (
        "transformedGatewayRequest" in out["mcp"] and "transformedGatewayResponse" not in out["mcp"]
    )


def _sent_args(out: dict) -> dict:
    return out["mcp"]["transformedGatewayRequest"]["body"]["params"]["arguments"]


def _reason(out: dict) -> str:
    """The denial reason the caller receives; fails the test if the send was allowed through."""
    assert not _passed(out), "expected a rejection, but the send was forwarded to Graph"
    result = out["mcp"]["transformedGatewayResponse"]["body"]["result"]
    assert result["isError"] is True
    return result["content"][0]["text"]


def _logged(caplog) -> str:
    """The single interceptor warning line — for the log-mode case, where nothing is returned."""
    hits = [r.getMessage() for r in caplog.records if SEND_TOOL in r.getMessage()]
    assert len(hits) == 1, f"expected exactly one interceptor verdict, got {hits}"
    return hits[0]


@pytest.fixture(autouse=True)
def _env(monkeypatch, caplog):
    """A fully configured interceptor: token, both tables, counterparty allowlist.

    The allowlist is part of the DEFAULT environment here so that a rejection in the counterparty
    cases below is attributable to the draft comparison under test. Its own failure modes — an
    address outside the list, and no list configured at all — get dedicated tests.
    """
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", TOKEN)
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    monkeypatch.setenv("COUNTERPARTY_EMAIL_DOMAINS", COUNTERPARTY_DOMAIN)
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    caplog.set_level(logging.WARNING, logger="backend.gateway_interceptor.handler")


def _tables(*, contact_active: bool = True, contact_kind: str = "counterparty"):
    """Create the cases and contacts tables, seeded with one counterparty and one internal contact.

    Both tables are created together because the counterparty branch reads both: the draft names a
    contact id, and the interceptor resolves it itself rather than trusting any stored address. The
    internal contact is seeded here too, so that a notification test asserting a pass-through does not
    have to restate the whole table.

    :param contact_active: whether the seeded COUNTERPARTY contact is active; False models a
        deactivation landing after the analyst approved.
    :param contact_kind: the seeded counterparty contact's kind; another value models a draft citing an
        internal notification address.
    :returns: the moto DynamoDB resource.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CASES_TABLE,
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName=CONTACTS_TABLE,
        KeySchema=[{"AttributeName": "contact_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "contact_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table(CONTACTS_TABLE).put_item(
        Item={
            "contact_id": CONTACT_ID,
            "display_name": "CINDERMOOR LOGISTICS HOLDINGS INC.",
            "email": COUNTERPARTY,
            "kind": contact_kind,
            "active": contact_active,
        }
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
    return ddb


def _seed_draft(ddb, *, item_id="i-1", **overrides):
    draft = {
        # None, as every persisted draft's is: the address is resolved at send time from the id below.
        "recipient": None,
        "recipient_contact_id": CONTACT_ID,
        "recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "subject": APPROVED_SUBJECT,
        "body": APPROVED_BODY,
        "draft_status": "approved",
        "revision": 2,
        "approved_revision": 2,
    }
    draft.update(overrides)
    ddb.Table(CASES_TABLE).put_item(
        Item={"item_id": item_id, "status": "PROPOSED", "proposed_email": draft}
    )


def _counterparty_event(*, item_id: str = "i-1", recipient: str = COUNTERPARTY, **kwargs) -> dict:
    """A well-formed counterparty send: single recipient, declared purpose, declared item."""
    return _event(
        _args(recipients=[recipient], sendPurpose="counterparty", reconItemId=item_id, **kwargs)
    )


# --- notification: checked against the operator's own contact list -------------------------------


@mock_aws
@pytest.mark.parametrize("mode", ["log", "enforce"])
def test_a_notification_to_an_active_internal_contact_is_authorized(monkeypatch, mode):
    monkeypatch.setenv("INTERCEPTOR_MODE", mode)
    _tables()
    assert _passed(handle(_event(_args(recipients=[NOTIFY], sendPurpose="notification"))))


@mock_aws
def test_notification_address_comparison_ignores_case():
    """The contact row stores one casing; Graph callers and humans type another. Both are the address."""
    _tables()
    out = handle(_event(_args(recipients=["OPS@Operator.Example"], sendPurpose="notification")))
    assert _passed(out)


@mock_aws
def test_a_notification_to_any_other_address_is_denied():
    """The exfiltration shape: internal status mail redirected outward."""
    _tables()
    out = handle(_event(_args(recipients=["evil@attacker.example"], sendPurpose="notification")))
    assert "is not an active internal_notification contact" in _reason(out)


@mock_aws
def test_a_notification_to_a_counterparty_contact_is_denied():
    """The two kinds are disjoint on purpose, and this is the case that proves the notification side.

    ``COUNTERPARTY`` is a real, active row in the table — so a check that only asked "is this address
    one of ours" would wave it through and let internal status mail (case ids, resolutions, confidence
    scores) reach a party outside the operator. Only the `kind` filter refuses it.
    """
    _tables()
    out = handle(_event(_args(recipients=[COUNTERPARTY], sendPurpose="notification")))
    assert "is not an active internal_notification contact" in _reason(out)


# --- an absent or unknown purpose denies ---------------------------------------------------------


def test_a_send_with_no_purpose_at_all_is_denied():
    """Omission is the DENYING path — the whole reason the purpose is an explicit enum.

    This is also the regression guard for the send paths that predate the feature: a caller shipping
    a bare token with no declared purpose is now refused, so no path can quietly keep the old
    capability-only authorization.
    """
    out = handle(_event(_args(recipients=[NOTIFY])))
    assert "unrecognized sendPurpose '<absent>'" in _reason(out)


def test_an_unknown_purpose_is_denied():
    out = handle(_event(_args(recipients=[NOTIFY], sendPurpose="urgent")))
    assert "unrecognized sendPurpose" in _reason(out)


@mock_aws
def test_a_padded_mixed_case_notification_is_still_a_notification():
    """Case and padding are representation, not intent."""
    _tables()
    out = handle(_event(_args(recipients=[NOTIFY], sendPurpose="  Notification ")))
    assert _passed(out)


def test_a_padded_mixed_case_counterparty_reaches_the_counterparty_branch():
    """Denied, but for the branch's own reason — proving normalization happened before matching."""
    out = handle(_event(_args(recipients=[COUNTERPARTY], sendPurpose="  COUNTERPARTY  ")))
    reason = _reason(out)
    assert "requires reconItemId" in reason
    assert "unrecognized" not in reason


# --- recipient cardinality ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "recipients", [[], [NOTIFY, "evil@attacker.example"]], ids=["none", "smuggled-second"]
)
def test_exactly_one_recipient_is_required(recipients):
    """With two recipients, "the recipient matches the draft" stops being true of the send."""
    out = handle(_event(_args(recipients=recipients, sendPurpose="notification")))
    assert "exactly one recipient" in _reason(out)


# --- counterparty: provenance against the persisted draft ----------------------------------------


@mock_aws
def test_a_counterparty_send_matching_the_approved_draft_is_authorized():
    _seed_draft(_tables())
    assert _passed(handle(_counterparty_event()))


@mock_aws
@pytest.mark.parametrize(
    "tampered, expected",
    [
        ({"recipient": "someone.else@counterparty.example"}, "recipient does not match"),
        ({"subject": APPROVED_SUBJECT + "!"}, "subject does not match"),
        ({"body": APPROVED_BODY.replace("2026-08-03", "2026-08-04")}, "body does not match"),
    ],
    ids=["recipient", "subject", "body"],
)
def test_any_edit_to_the_message_is_denied(tampered, expected):
    """The point of the change: the send must carry the text a human actually read.

    Each case changes ONE field by one plausible edit — a different address in the SAME domain, so
    the allowlist still passes and provenance is what refuses; an added character; a date shifted by
    a day.
    """
    _seed_draft(_tables())
    out = handle(_counterparty_event(**tampered))
    assert expected in _reason(out)


@mock_aws
@pytest.mark.parametrize("status", ["pending", "discarded", "sent"])
def test_only_an_approved_draft_authorizes_a_counterparty_send(status):
    _seed_draft(_tables(), draft_status=status)
    out = handle(_counterparty_event())
    assert f"draft is {status}, not approved" in _reason(out)


@mock_aws
def test_an_edit_landing_after_approval_is_denied():
    """Revision pinning at the gateway: approve-draft and send are separate requests.

    The outgoing text still matches the stored draft, so provenance alone would allow this send.
    Only the pinned revision catches the edit that landed in between.
    """
    _seed_draft(_tables(), revision=3, approved_revision=2)
    out = handle(_counterparty_event())
    assert "revision moved since approval" in _reason(out)


@mock_aws
def test_a_case_with_no_draft_cannot_send_to_a_counterparty():
    _tables().Table(CASES_TABLE).put_item(Item={"item_id": "i-2", "status": "PROPOSED"})
    out = handle(_counterparty_event(item_id="i-2"))
    assert "no email draft persisted" in _reason(out)


@mock_aws
def test_an_unknown_case_cannot_send():
    _tables()
    out = handle(_counterparty_event(item_id="nope"))
    assert "no case found" in _reason(out)


def test_a_counterparty_send_without_an_item_id_is_denied():
    """Checked before the read, so an unattributed send never even looks a case up."""
    out = handle(_event(_args(recipients=[COUNTERPARTY], sendPurpose="counterparty")))
    assert "requires reconItemId" in _reason(out)


def test_the_check_fails_closed_when_the_lookup_raises(monkeypatch):
    """No CASES_TABLE and no moto: the DynamoDB read raises, and that must read as a denial.

    The allowlist stays configured here on purpose — otherwise the send would be refused before the
    read this test exists to exercise, and would pass without proving anything about the failure.

    Static dummy credentials are injected because this is the one test in the file that runs WITHOUT
    ``@mock_aws``, so botocore resolves the developer's real credential chain. On a machine whose
    shared config uses a provider botocore cannot load, that resolution raises FIRST and the denial
    reason names that exception instead of the missing-table ``KeyError`` — the control still fails
    closed, but the assertion below would be testing the laptop rather than the handler.
    """
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    monkeypatch.delenv("CASES_TABLE")
    out = handle(_counterparty_event())
    assert "sendPurpose check failed: KeyError" in _reason(out)


# --- the domain allowlist, checked independently of provenance ------------------------------------


@mock_aws
def test_an_out_of_allowlist_recipient_is_denied_even_with_a_matching_approved_draft():
    """The two counterparty checks are independent, and this is the case that proves it.

    The draft is approved, at its approved revision, and the send matches it exactly — provenance is
    perfectly satisfied. It is still refused, because the persisted address may predate a narrowed
    allowlist, or have been written by a compromised BFF that then approved its own draft. "A human
    approved this text" and "this is an address we may ever write to" are separate questions.
    """
    attacker = "ap@attacker.example"
    _seed_draft(_tables(), recipient=attacker)
    out = handle(_counterparty_event(recipient=attacker))
    reason = _reason(out)
    assert "not in an allowed counterparty domain" in reason
    assert COUNTERPARTY_DOMAIN in reason  # names what IS allowed, so the operator can act on it


@mock_aws
def test_no_allowlist_configured_allows_no_counterparty_send(monkeypatch):
    """A missing allowlist closes the door rather than opening it."""
    monkeypatch.delenv("COUNTERPARTY_EMAIL_DOMAINS")
    _seed_draft(_tables())
    assert "none configured" in _reason(handle(_counterparty_event()))


def test_a_lookalike_domain_does_not_satisfy_the_allowlist():
    """Suffix matching would make the allowlist worthless. No table is seeded: the allowlist is
    checked before the read, so reaching a denial without moto is itself part of the assertion."""
    out = handle(_counterparty_event(recipient="ap@counterparty.example.attacker.io"))
    assert "not in an allowed counterparty domain" in _reason(out)


# --- the two checks are independent and both enforced --------------------------------------------


@mock_aws
def test_an_unconfirmed_send_is_still_denied_on_the_token_alone():
    """The purpose check is additive: it must not weaken the existing capability gate.

    The contacts table is seeded so the purpose check PASSES — otherwise this test would still go red
    if the token gate were deleted, on the purpose reason, and prove nothing about the token.
    """
    _tables()
    args = _args(recipients=[NOTIFY], sendPurpose="notification")
    args.pop("confirmationToken")
    assert "requires human confirmation" in _reason(handle(_event(args)))


@mock_aws
def test_a_send_failing_both_checks_is_told_about_both():
    """One round-trip, both reasons. Handing back one failure at a time is how a real approval gets
    abandoned as "the button is broken"."""
    _tables()
    args = _args(recipients=["evil@attacker.example"], sendPurpose="notification")
    args.pop("confirmationToken")
    reason = _reason(handle(_event(args)))
    assert "requires human confirmation" in reason
    assert "is not an active internal_notification contact" in reason


# --- log mode observes without blocking ----------------------------------------------------------


@mock_aws
def test_log_mode_forwards_a_send_it_would_have_denied_and_says_why(monkeypatch, caplog):
    """The mode's whole contract: identical verdict, no teeth. This is what a rollout runs first."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "log")
    _tables()
    out = handle(_event(_args(recipients=["evil@attacker.example"], sendPurpose="notification")))
    assert _passed(out)
    assert "is not an active internal_notification contact" in _logged(caplog)


# --- the new arguments never reach Graph ----------------------------------------------------------


@mock_aws
def test_the_purpose_arguments_are_stripped_before_forwarding():
    """Same reason the token is stripped: Graph 400s on unknown fields in the send payload."""
    _tables()
    out = handle(_event(_args(recipients=[NOTIFY], sendPurpose="notification", reconItemId="i-1")))
    args = _sent_args(out)
    assert "sendPurpose" not in args
    assert "reconItemId" not in args
    assert "confirmationToken" not in args
    assert args["mailboxAddress"] == "shared@operator.example"
    assert args["message"]["subject"] == APPROVED_SUBJECT
