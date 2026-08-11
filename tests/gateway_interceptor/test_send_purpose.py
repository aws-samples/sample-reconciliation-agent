"""The interceptor's ``sendPurpose`` gate, now enforced.

These cases were written one step earlier against the observe-only version, where every one of them
asserted a pass-through and pinned the verdict through ``caplog``. Turning on enforcement inverted
them: the same inputs, the same expected reasons, but the reason now arrives in a rejection the
caller receives instead of a log line only an operator would ever read. The two authorized shapes —
a notification to the operator's own address, and a counterparty send matching an approved draft —
still assert a pass-through, because a gate that denies everything is not a working gate.

``log`` mode is covered explicitly rather than by parametrizing every case: its contract is that it
evaluates the same verdict and forwards anyway, and one test can establish that.
"""

import logging

import boto3
import pytest
from moto import mock_aws

from backend.gateway_interceptor.handler import handle

CASES_TABLE = "recon-dev-cases"
TOKEN = "secret-tok"  # nosec B105 - test fixture, not a real secret
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
    return "transformedGatewayRequest" in out["mcp"] and "transformedGatewayResponse" not in out["mcp"]


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
    """A fully configured interceptor: token, notify address, cases table, counterparty allowlist.

    The allowlist is part of the DEFAULT environment here so that a rejection in the counterparty
    cases below is attributable to the draft comparison under test. Its own failure modes — an
    address outside the list, and no list configured at all — get dedicated tests.
    """
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", TOKEN)
    monkeypatch.setenv("RECON_NOTIFY_EMAIL", NOTIFY)
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    monkeypatch.setenv("COUNTERPARTY_EMAIL_DOMAINS", COUNTERPARTY_DOMAIN)
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    caplog.set_level(logging.WARNING, logger="backend.gateway_interceptor.handler")


def _cases_table():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CASES_TABLE,
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb


def _seed_draft(ddb, *, item_id="i-1", **overrides):
    draft = {
        "recipient": COUNTERPARTY,
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


# --- notification: env comparison, zero I/O ------------------------------------------------------


@pytest.mark.parametrize("mode", ["log", "enforce"])
def test_a_notification_to_the_configured_address_is_authorized(monkeypatch, mode):
    """No table is created here: this branch must not touch DynamoDB, or moto would raise."""
    monkeypatch.setenv("INTERCEPTOR_MODE", mode)
    assert _passed(handle(_event(_args(recipients=[NOTIFY], sendPurpose="notification"))))


def test_notification_address_comparison_ignores_case():
    out = handle(_event(_args(recipients=["OPS@Operator.Example"], sendPurpose="notification")))
    assert _passed(out)


def test_a_notification_to_any_other_address_is_denied():
    """The exfiltration shape: internal status mail redirected outward."""
    out = handle(_event(_args(recipients=["evil@attacker.example"], sendPurpose="notification")))
    assert "not the configured notify address" in _reason(out)


def test_a_notification_with_no_notify_address_configured_is_denied(monkeypatch):
    """Misconfiguration must read as a denial, not as "nothing to compare, therefore fine"."""
    monkeypatch.delenv("RECON_NOTIFY_EMAIL")
    out = handle(_event(_args(recipients=[NOTIFY], sendPurpose="notification")))
    assert "RECON_NOTIFY_EMAIL is not configured" in _reason(out)


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


def test_a_padded_mixed_case_notification_is_still_a_notification():
    """Case and padding are representation, not intent."""
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
    _seed_draft(_cases_table())
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
    _seed_draft(_cases_table())
    out = handle(_counterparty_event(**tampered))
    assert expected in _reason(out)


@mock_aws
@pytest.mark.parametrize("status", ["pending", "discarded", "sent"])
def test_only_an_approved_draft_authorizes_a_counterparty_send(status):
    _seed_draft(_cases_table(), draft_status=status)
    out = handle(_counterparty_event())
    assert f"draft is {status}, not approved" in _reason(out)


@mock_aws
def test_an_edit_landing_after_approval_is_denied():
    """Revision pinning at the gateway: approve-draft and send are separate requests.

    The outgoing text still matches the stored draft, so provenance alone would allow this send.
    Only the pinned revision catches the edit that landed in between.
    """
    _seed_draft(_cases_table(), revision=3, approved_revision=2)
    out = handle(_counterparty_event())
    assert "revision moved since approval" in _reason(out)


@mock_aws
def test_a_case_with_no_draft_cannot_send_to_a_counterparty():
    _cases_table().Table(CASES_TABLE).put_item(Item={"item_id": "i-2", "status": "PROPOSED"})
    out = handle(_counterparty_event(item_id="i-2"))
    assert "no email draft persisted" in _reason(out)


@mock_aws
def test_an_unknown_case_cannot_send():
    _cases_table()
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
    """
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
    _seed_draft(_cases_table(), recipient=attacker)
    out = handle(_counterparty_event(recipient=attacker))
    reason = _reason(out)
    assert "not in an allowed counterparty domain" in reason
    assert COUNTERPARTY_DOMAIN in reason  # names what IS allowed, so the operator can act on it


@mock_aws
def test_no_allowlist_configured_allows_no_counterparty_send(monkeypatch):
    """A missing allowlist closes the door rather than opening it."""
    monkeypatch.delenv("COUNTERPARTY_EMAIL_DOMAINS")
    _seed_draft(_cases_table())
    assert "none configured" in _reason(handle(_counterparty_event()))


def test_a_lookalike_domain_does_not_satisfy_the_allowlist():
    """Suffix matching would make the allowlist worthless. No table is seeded: the allowlist is
    checked before the read, so reaching a denial without moto is itself part of the assertion."""
    out = handle(_counterparty_event(recipient="ap@counterparty.example.attacker.io"))
    assert "not in an allowed counterparty domain" in _reason(out)


# --- the two checks are independent and both enforced --------------------------------------------


def test_an_unconfirmed_send_is_still_denied_on_the_token_alone():
    """The purpose check is additive: it must not weaken the existing capability gate."""
    args = _args(recipients=[NOTIFY], sendPurpose="notification")
    args.pop("confirmationToken")
    assert "requires human confirmation" in _reason(handle(_event(args)))


def test_a_send_failing_both_checks_is_told_about_both():
    """One round-trip, both reasons. Handing back one failure at a time is how a real approval gets
    abandoned as "the button is broken"."""
    args = _args(recipients=["evil@attacker.example"], sendPurpose="notification")
    args.pop("confirmationToken")
    reason = _reason(handle(_event(args)))
    assert "requires human confirmation" in reason
    assert "not the configured notify address" in reason


# --- log mode observes without blocking ----------------------------------------------------------


def test_log_mode_forwards_a_send_it_would_have_denied_and_says_why(monkeypatch, caplog):
    """The mode's whole contract: identical verdict, no teeth. This is what a rollout runs first."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "log")
    out = handle(_event(_args(recipients=["evil@attacker.example"], sendPurpose="notification")))
    assert _passed(out)
    assert "not the configured notify address" in _logged(caplog)


# --- the new arguments never reach Graph ----------------------------------------------------------


def test_the_purpose_arguments_are_stripped_before_forwarding():
    """Same reason the token is stripped: Graph 400s on unknown fields in the send payload."""
    out = handle(_event(_args(recipients=[NOTIFY], sendPurpose="notification", reconItemId="i-1")))
    args = _sent_args(out)
    assert "sendPurpose" not in args
    assert "reconItemId" not in args
    assert "confirmationToken" not in args
    assert args["mailboxAddress"] == "shared@operator.example"
    assert args["message"]["subject"] == APPROVED_SUBJECT
