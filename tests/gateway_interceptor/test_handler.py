"""Tests for the gateway REQUEST interceptor (provenance + transition guard at the gateway)."""


import boto3
from moto import mock_aws

from backend.gateway_interceptor.handler import handle

CASES_TABLE = "recon-dev-cases"
NOTICES_TABLE = "recon-dev-notices"


def _event(method: str = "tools/call", tool: str = "", args: dict | None = None) -> dict:
    body: dict = {"jsonrpc": "2.0", "id": 7, "method": method}
    if method == "tools/call":
        body["params"] = {"name": tool, "arguments": args or {}}
    return {
        "interceptorInputVersion": "1.0",
        "mcp": {"gatewayRequest": {"path": "/mcp", "httpMethod": "POST", "body": body}},
    }


def _make_cases_table():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CASES_TABLE,
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb


def _make_notices_table():
    """Create the notices table the extraction-confidence guard reads.

    Only the hash key is needed here — the guard does a GetItem by notice_id and never queries a GSI.

    :returns: the boto3 DynamoDB resource.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=NOTICES_TABLE,
        KeySchema=[{"AttributeName": "notice_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "notice_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb


def _seed(
    ddb,
    *,
    item_id="i-1",
    status="PROPOSED",
    reference="DDTL-A-0001",
    verdict="CLEAN",
    reason="notice n-1 extraction flagged no low-confidence fields",
):
    """Seed a case row carrying the evidence verdict its proposal recorded.

    ``verdict=None`` leaves the key OFF entirely, which is what every case row written before the
    evidence guard existed looks like — and which the guard refuses. That is the inverse of the previous
    guard, where an absent notice id was the one shape allowed through unchecked.
    """
    action = {"tool": "set_draw_status", "reference": reference, "status": "Cancelled"}
    if verdict is not None:
        action["evidence_quality"] = verdict
        action["evidence_quality_reason"] = reason
    ddb.Table(CASES_TABLE).put_item(
        Item={"item_id": item_id, "status": status, "proposed_action": action}
    )


def _passed(out: dict) -> bool:
    return (
        "transformedGatewayRequest" in out["mcp"] and "transformedGatewayResponse" not in out["mcp"]
    )


def _rejected(out: dict) -> bool:
    return "transformedGatewayResponse" in out["mcp"]


def _rejection_text(out: dict) -> str:
    return out["mcp"]["transformedGatewayResponse"]["body"]["result"]["content"][0]["text"]


def test_non_tools_call_and_reads_pass_through_with_zero_io(monkeypatch):
    """tools/list and read tools never touch DynamoDB (no table exists here — would raise)."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    assert _passed(handle(_event(method="tools/list")))
    assert _passed(handle(_event(tool="general-ledger___search_ledger", args={"reference": "X"})))


def _sent_args(out: dict) -> dict:
    """The forwarded tool arguments from a pass-through send."""
    return out["mcp"]["transformedGatewayRequest"]["body"]["params"]["arguments"]


def test_email_send_denied_without_confirmation_in_enforce(monkeypatch):
    """The agent's autonomous send (no confirmation token) is blocked in enforce mode."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", "secret-tok")
    out = handle(
        _event(
            tool="microsoft-graph___sendSharedMailboxMail",
            args={"mailboxAddress": "s@x.com", "message": {}},
        )
    )
    assert _rejected(out)
    assert "requires human confirmation" in _rejection_text(out)


@mock_aws
def test_email_send_allowed_with_valid_token_and_token_stripped(monkeypatch):
    """A human-driven send carrying the correct token passes — and the token is removed before
    forwarding (Graph would reject the unknown field).

    The token alone authorizes nothing, so this has to be a fully valid send: a ``notification`` to
    somebody the operator's contacts table actually lists. Hence the seeded table — the notify
    address is operator data, not configuration. ``test_send_purpose.py`` covers the purpose gate.
    """
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", "secret-tok")
    monkeypatch.setenv("CONTACTS_TABLE", "recon-dev-contacts")
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-dev-contacts",
        KeySchema=[{"AttributeName": "contact_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "contact_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table("recon-dev-contacts").put_item(
        Item={
            "contact_id": "int-ops",
            "display_name": "Reconciliation Operations",
            "email": "ops@x.com",
            "kind": "internal_notification",
            "active": True,
        }
    )
    out = handle(
        _event(
            tool="microsoft-graph___sendSharedMailboxMail",
            args={
                "mailboxAddress": "s@x.com",
                "message": {"toRecipients": [{"emailAddress": {"address": "ops@x.com"}}]},
                "sendPurpose": "notification",
                "confirmationToken": "secret-tok",
            },
        )
    )
    assert _passed(out)
    args = _sent_args(out)
    assert "confirmationToken" not in args  # stripped
    assert "sendPurpose" not in args
    assert args["mailboxAddress"] == "s@x.com"


def test_email_send_wrong_token_denied(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", "secret-tok")
    out = handle(
        _event(
            tool="microsoft-graph___sendSharedMailboxMail",
            args={"message": {}, "confirmationToken": "WRONG"},
        )
    )
    assert _rejected(out)


def test_email_send_log_mode_allows_but_strips_token(monkeypatch):
    """log mode never blocks, but still strips any token so it never leaks to Graph."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "log")
    monkeypatch.setenv("EMAIL_CONFIRMATION_TOKEN", "secret-tok")
    out = handle(
        _event(
            tool="microsoft-graph___sendSharedMailboxMail",
            args={"message": {}, "confirmationToken": "anything"},
        )
    )
    assert _passed(out)
    assert "confirmationToken" not in _sent_args(out)


@mock_aws
def test_provenance_match_passes(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table())
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-A-0001", "status": "Cancelled"},
        )
    )
    assert _passed(out)


@mock_aws
def test_provenance_mismatch_rejected_in_enforce(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table())
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-Z-9999", "status": "Cancelled"},
        )
    )
    assert _rejected(out)
    assert "does not match persisted" in _rejection_text(out)
    # The JSON-RPC id is mirrored so the caller can correlate the error.
    assert out["mcp"]["transformedGatewayResponse"]["body"]["id"] == 7


@mock_aws
def test_provenance_missing_action_rejected(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _make_cases_table()  # table exists, no row
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-missing", "reference": "R", "status": "Cancelled"},
        )
    )
    assert _rejected(out)
    assert "no persisted proposed_action" in _rejection_text(out)


@mock_aws
def test_a_doubtful_verdict_blocks_the_ledger_write(monkeypatch):
    """The categorical block, now keyed on a recorded verdict rather than a notice lookup."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(
        _make_cases_table(),
        verdict="DOUBTFUL",
        reason="3 extracted field(s) on notice n-1 were flagged low-confidence",
    )
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-A-0001", "status": "Cancelled"},
        )
    )
    assert not _passed(out)
    # The RECORDED reason is quoted, not a restatement of it: an operator needs the specific finding.
    assert "flagged low-confidence" in _rejection_text(out)


@mock_aws
def test_an_unverifiable_verdict_blocks_the_ledger_write(monkeypatch):
    """Distinct from DOUBTFUL, and the denial must carry which one it was.

    "We checked and it is bad" and "we could not check" send an operator to different places — the
    document in one case, the pipeline or a Config toggle in the other.
    """
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(
        _make_cases_table(),
        verdict="UNVERIFIABLE",
        reason="the knowledge-base route is not enabled as an evidence source in Config",
    )
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-A-0001", "status": "Cancelled"},
        )
    )
    assert not _passed(out)
    assert "unverifiable" in _rejection_text(out).lower()
    assert "Config" in _rejection_text(out)


@mock_aws
def test_an_absent_verdict_refuses(monkeypatch):
    """⚠️ The inversion. Absence used to be the one shape allowed through; now it refuses.

    Every case row written before this guard existed lacks the key. Those cases must be re-run, and the
    denial says so — an operator seeing it needs to know the case is stale, not that the guard is broken.
    """
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table(), verdict=None)
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-A-0001", "status": "Cancelled"},
        )
    )
    assert not _passed(out)
    assert "re-run" in _rejection_text(out)


@mock_aws
def test_an_unrecognised_verdict_refuses(monkeypatch):
    """Anything that is not CLEAN refuses, including a value this handler has never heard of.

    An allowlist rather than a denylist: a new verdict added upstream must not become permissive here
    just because this file has not been updated.
    """
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table(), verdict="PROBABLY_FINE", reason="invented upstream")
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-A-0001", "status": "Cancelled"},
        )
    )
    assert not _passed(out)


@mock_aws
def test_both_write_guards_are_reported_together(monkeypatch):
    """Provenance and the evidence verdict are independent, and a caller failing both hears both once."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table(), verdict="DOUBTFUL", reason="2 extracted field(s) were flagged")
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "WRONG-REF", "status": "Cancelled"},
        )
    )
    assert not _passed(out)
    reason = _rejection_text(out)
    assert "provenance" in reason and "evidence quality" in reason


@mock_aws
def test_the_guard_does_not_read_the_notices_table(monkeypatch):
    """The whole point of the rewrite: zero extra I/O on the write path.

    Asserted by leaving NOTICES_TABLE unset and the table uncreated. The previous guard would have raised
    a KeyError on the env var; this one must not touch it at all.
    """
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    monkeypatch.delenv("NOTICES_TABLE", raising=False)
    _seed(_make_cases_table())
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "DDTL-A-0001", "status": "Cancelled"},
        )
    )
    assert _passed(out)


@mock_aws
def test_a_doubtful_verdict_does_not_block_a_status_transition(monkeypatch):
    """The guard is scoped to the LEDGER write. Moving a case through its own state machine — the very
    thing a human needs to do with doubtful evidence — stays allowed."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table(), status="PROPOSED", verdict="DOUBTFUL", reason="fields were flagged")
    out = handle(
        _event(
            tool="recon-status___recon_update_status",
            args={"item_id": "i-1", "new_status": "APPROVED"},
        )
    )
    assert _passed(out)


@mock_aws
def test_log_mode_never_blocks(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "log")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table())
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "WRONG", "status": "Cancelled"},
        )
    )
    assert _passed(out)  # would-be rejection is only logged


@mock_aws
def test_status_tool_transition_guard(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    _seed(_make_cases_table(), status="PROPOSED")
    ok = handle(
        _event(
            tool="recon-status___recon_update_status",
            args={"item_id": "i-1", "new_status": "APPROVED"},
        )
    )
    assert _passed(ok)
    bad = handle(
        _event(
            tool="recon-status___recon_update_status",
            args={"item_id": "i-1", "new_status": "RESOLVED"},
        )
    )
    assert _rejected(bad)
    assert "illegal transition PROPOSED->RESOLVED" in _rejection_text(bad)


def test_internal_error_fails_closed_for_gated_tools_in_enforce(monkeypatch):
    """CASES_TABLE unset -> the check itself errors -> enforce mode rejects (fail-closed)."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.delenv("CASES_TABLE", raising=False)
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "R", "status": "Cancelled"},
        )
    )
    assert _rejected(out)
    assert "gateway-layer check failed" in _rejection_text(out)


def test_internal_error_passes_in_log_mode(monkeypatch):
    monkeypatch.setenv("INTERCEPTOR_MODE", "log")
    monkeypatch.delenv("CASES_TABLE", raising=False)
    out = handle(
        _event(
            tool="set-draw-status___set_draw_status",
            args={"item_id": "i-1", "reference": "R", "status": "Cancelled"},
        )
    )
    assert _passed(out)


# --- Graph mailbox-read OData normalization -------------------------------------------------
# Both coercions exist because the failures are opaque to the model (the MCP client reports only
# "unhandled errors in a TaskGroup"), so it retries the same broken shape indefinitely.

READ_TOOL = "microsoft-graph___listSharedMailboxMessages"


def test_read_coerces_numeric_string_top_to_int(monkeypatch):
    """The model emits `$top` as "10"; the Gateway's OpenAPI schema demands an integer."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    out = handle(_event(tool=READ_TOOL, args={"mailboxAddress": "s@x.io", "$top": "10"}))
    assert _passed(out)
    assert _sent_args(out)["$top"] == 10
    assert isinstance(_sent_args(out)["$top"], int)


def test_read_quotes_bare_search(monkeypatch):
    """OData rejects an unquoted `$search` containing a hyphen or a space."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    out = handle(
        _event(tool=READ_TOOL, args={"mailboxAddress": "s@x.io", "$search": "QA-E2E 100.00"})
    )
    assert _sent_args(out)["$search"] == '"QA-E2E 100.00"'


def test_read_normalization_is_idempotent(monkeypatch):
    """The gateway retries interceptor calls, so applying the transform twice must not double up."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    first = _sent_args(handle(_event(tool=READ_TOOL, args={"$search": "QA-E2E", "$top": "10"})))
    second = _sent_args(handle(_event(tool=READ_TOOL, args=first)))
    assert second == first == {"$search": '"QA-E2E"', "$top": 10}


def test_read_leaves_already_valid_args_untouched(monkeypatch):
    """A well-formed call is forwarded byte-for-byte — no gratuitous rewriting."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    args = {"mailboxAddress": "s@x.io", "$search": '"CASCADE paydown"', "$top": 10}
    assert _sent_args(handle(_event(tool=READ_TOOL, args=dict(args)))) == args


def test_read_leaves_non_numeric_top_for_the_schema_to_reject(monkeypatch):
    """ "ten" is a real error, not a representation mismatch — do not guess a value for it."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    out = handle(_event(tool=READ_TOOL, args={"$top": "ten"}))
    assert _sent_args(out)["$top"] == "ten"


def test_read_strips_inner_quotes_before_wrapping(monkeypatch):
    """Inner double quotes would break the OData literal, so they are dropped, not escaped."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    out = handle(_event(tool=READ_TOOL, args={"$search": 'say "hi" now'}))
    assert _sent_args(out)["$search"] == '"say hi now"'


def test_read_never_blocks_and_needs_no_dynamodb(monkeypatch):
    """Reads fail open: no CASES_TABLE here, so any DynamoDB touch would raise."""
    monkeypatch.setenv("INTERCEPTOR_MODE", "enforce")
    monkeypatch.delenv("CASES_TABLE", raising=False)
    assert _passed(handle(_event(tool=READ_TOOL, args={"$search": "QA-E2E", "$top": "5"})))
