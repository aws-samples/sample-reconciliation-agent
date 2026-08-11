"""LIVE smoke tests — one per recon egress-gateway target.

Each test exercises a target END-TO-END through the deployed gateway (SigV4 → interceptor →
Cedar Policy → target), so target/auth/policy regressions surface at the boundary where they
actually break (e.g. a stale credential-provider secret, an upstream contract change, or an
allowedTools/Policy misconfiguration) — unit tests on the tool Lambdas cannot see those.

These tests run ONLY when ``RECON_GATEWAY_URL`` is set (they need live AWS credentials for
the dev account and mutate dev tables with self-cleaning ``qa-live-*`` rows):

    RECON_GATEWAY_URL=https://recon-dev-gateway-....amazonaws.com \\
        python -m pytest tests/integration/ -q

Default ``pytest`` runs skip them, keeping CI green and AWS-free.
"""

import json
import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("RECON_GATEWAY_URL"),
    reason="live gateway smoke tests need RECON_GATEWAY_URL (+ AWS creds for the dev account)",
)

CASES_TABLE = os.environ.get("CASES_TABLE", "recon-dev-cases")
AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "recon-dev-audit")
GL_STATUS_TABLE = os.environ.get("GL_STATUS_TABLE", "recon-dev-gl-status")
# Placeholder fallback only: a send from this address cannot succeed, so a run that forgot to
# export GRAPH_MAILBOX fails at Graph instead of quietly exercising someone else's mailbox.
MAILBOX = os.environ.get("GRAPH_MAILBOX", "shared@recon.example")
# The interceptor's email human-confirmation token. Provisioned to the human-driven send paths
# (BFF ECS task + approve/auto-resolve notify), never to the agent runtime. When it is not in the
# environment only the denial half of the send contract can be exercised — see the two send tests.
CONFIRM_TOKEN = os.environ.get("EMAIL_CONFIRMATION_TOKEN")


def _call(tool: str, args: dict) -> dict:
    from backend.recon_core.gateway_client import call_gateway_tool

    return call_gateway_tool(tool, args)


def _text(result: dict) -> str:
    return "".join(c.get("text", "") for c in (result.get("content") or []))


@pytest.fixture()
def qa_case():
    """A throwaway PROPOSED case row with a persisted proposed_action (self-cleaning)."""
    import boto3

    item_id = f"qa-live-{uuid.uuid4().hex[:8]}"
    reference = f"QA-LIVE-{uuid.uuid4().hex[:6].upper()}"
    table = boto3.resource("dynamodb").Table(CASES_TABLE)
    table.put_item(Item={"item_id": item_id, "status": "PROPOSED",
                         "proposed_action": {"tool": "set_draw_status",
                                             "reference": reference, "status": "Confirmed"}})
    yield item_id, reference
    table.delete_item(Key={"item_id": item_id})
    boto3.resource("dynamodb").Table(GL_STATUS_TABLE).delete_item(Key={"reference": reference})


def test_general_ledger_search_ledger():
    """Target `general-ledger`: read returns a rows/count payload."""
    out = _call("general-ledger___search_ledger", {"limit": 1})
    payload = json.loads(_text(out))
    assert "rows" in payload and "count" in payload


def test_knowledge_base_search_guidance():
    """Target `knowledge-base`: guidance retrieval returns content."""
    out = _call("knowledge-base___search_guidance", {"query": "reconciliation break", "top_k": 1})
    assert not out.get("isError")
    assert _text(out).strip()


def test_recon_status_update_status(qa_case):
    """Target `recon-status` (platform-only). Two valid outcomes by principal:
    - platform principal (ECS task role): guarded transition succeeds;
    - any other principal (e.g. an engineer's role running this suite): Cedar default-deny —
      which PROVES the platform-only gate. Both are asserted; silent no-ops are failures."""
    item_id, _ = qa_case
    try:
        out = _call("recon-status___recon_update_status",
                    {"item_id": item_id, "new_status": "APPROVED", "actor": "qa-live"})
    except RuntimeError as exc:
        assert "policy" in str(exc).lower() or "denied" in str(exc).lower(), str(exc)
        return  # non-platform principal correctly denied — the gate works
    payload = json.loads(_text(out))
    assert payload["transitioned"] is True and payload["status"] == "APPROVED"
    # Illegal jump reports transitioned=false (or the interceptor rejects it in enforce mode).
    try:
        out2 = _call("recon-status___recon_update_status",
                     {"item_id": item_id, "new_status": "PENDING", "actor": "qa-live"})
        assert json.loads(_text(out2))["transitioned"] is False
    except RuntimeError as exc:
        assert "interceptor" in str(exc) or "illegal transition" in str(exc)


def test_set_draw_status_write_with_provenance(qa_case):
    """Target `set-draw-status`: Policy-gated write executes when confidence clears the gate
    and the reference matches the persisted proposed_action; provenance mismatch is denied."""
    item_id, reference = qa_case
    out = _call("set-draw-status___set_draw_status",
                {"reference": reference, "status": "Confirmed", "reason": "qa-live",
                 "item_id": item_id, "confidence": 100.0})  # float: Cedar decimal typing
    payload = json.loads(_text(out))
    assert payload["reference"] == reference
    with pytest.raises(RuntimeError, match="provenance|denied"):
        _call("set-draw-status___set_draw_status",
              {"reference": "QA-WRONG-REF", "status": "Confirmed",
               "item_id": item_id, "confidence": 100.0})


def test_microsoft_graph_read_mailbox():
    """Target `microsoft-graph`: shared-mailbox read (the correspondence-search path)."""
    out = _call("microsoft-graph___listSharedMailboxMessages",
                {"mailboxAddress": MAILBOX, "$top": 1})
    assert not out.get("isError"), _text(out)


def test_microsoft_graph_read_mailbox_tolerates_model_arg_shapes():
    """Target `microsoft-graph`: the shape the MODEL actually emits must work end-to-end.

    The test above sends `$top` as an int with no `$search` — the one combination that always
    worked, which is why it stayed green while every real agent call failed. This sends the two
    forms the model emits instead (`$top` as the string "1", `$search` unquoted and containing a
    hyphen); the gateway interceptor normalizes both. Without it the call fails as an opaque
    `unhandled errors in a TaskGroup` that the model cannot self-correct from.
    """
    out = _call("microsoft-graph___listSharedMailboxMessages",
                {"mailboxAddress": MAILBOX, "$top": "1", "$search": "QA-LIVE recon"})
    assert not out.get("isError"), _text(out)


def test_correspondence_search_sanitized_mailbox_read():
    """Target `correspondence-search`: the model-facing mailbox read, with plain arguments.

    This is the ONLY mailbox read the harness model is offered (the raw Graph op's `$`-prefixed
    OData params are not valid Bedrock tool-schema property names). The wrapper Lambda re-enters
    this same gateway to call `microsoft-graph___listSharedMailboxMessages`, so a pass here also
    proves the second Cedar action and the wrapper's own gateway egress are in place.
    """
    out = _call("correspondence-search___search_correspondence", {"query": "QA-LIVE recon", "top": 1})
    assert not out.get("isError"), _text(out)


def test_correspondence_search_rejects_odata_argument_names():
    """The wrapper owns the OData translation: the model must not be able to smuggle it in.

    `mailboxAddress` is deployment config (GRAPH_MAILBOX), not an argument — a caller-supplied one
    is ignored rather than honoured, so this call cannot be redirected at another mailbox. An
    unknown property is rejected by the target's inline schema.
    """
    out = _call("correspondence-search___search_correspondence",
                {"query": "QA-LIVE recon", "mailboxAddress": "someone-else@example.com"})
    # Either the gateway rejects the unknown property, or the Lambda ignores it and reads the
    # configured mailbox. Both are correct; silently reading the CALLER's mailbox would not be.
    if not out.get("isError"):
        assert "someone-else@example.com" not in _text(out)


def _send_args(subject: str) -> dict:
    """Build a `sendSharedMailboxMail` argument dict addressed to the shared mailbox itself.

    :param subject: the message subject (identifies which test produced the mail).
    :returns: the tool arguments, without any confirmation token.
    """
    return {
        "mailboxAddress": MAILBOX,
        "message": {"subject": subject,
                    "body": {"contentType": "Text",
                             "content": "Automated per-target smoke test - safe to ignore."},
                    "toRecipients": [{"emailAddress": {"address": MAILBOX}}]},
        "saveToSentItems": True,
    }


def test_microsoft_graph_send_mail_denied_without_confirmation():
    """Target `microsoft-graph`: an unconfirmed send MUST be denied by the interceptor.

    This is the autonomous-agent path — the runtime container has no confirmation token, so this
    denial is exactly what stops the agent emailing a counterparty without a human. It is the half
    of the contract that holds for every caller, so it is asserted unconditionally.
    """
    with pytest.raises(RuntimeError, match="human confirmation"):
        _call("microsoft-graph___sendSharedMailboxMail",
              _send_args("[Recon QA] unconfirmed send - must be denied"))


@pytest.mark.skipif(not CONFIRM_TOKEN,
                    reason="confirmed-send path needs EMAIL_CONFIRMATION_TOKEN (the value the "
                           "interceptor checks; read it from the frontend ECS task definition)")
def test_microsoft_graph_send_mail_with_confirmation():
    """Target `microsoft-graph`: a token-carrying send succeeds (the human-approved send path).

    Proves the safeguard gates rather than blocks: the same call that is denied above goes through
    once it carries the confirmation token. The interceptor strips the token before forwarding, so
    Graph never sees the extra field.
    """
    args = _send_args("[Recon QA] confirmed send - live gateway smoke test")
    args["confirmationToken"] = CONFIRM_TOKEN
    out = _call("microsoft-graph___sendSharedMailboxMail", args)
    assert not out.get("isError"), _text(out)


def test_document_extraction_get_results_connectivity():
    """Target `document-extraction` (external IDP MCP): connectivity + auth are OURS to
    guarantee; the current upstream contract requires `batch_id` (IDP-side change,
    2026-07-26). A structured IDP ValidationException therefore PROVES the full recon-side
    chain works; anything transport/auth-shaped fails the test."""
    try:
        out = _call("document-extraction___IDPTools___get_results", {"documentId": "qa-live-probe"})
        # If IDP restores documentId-based lookup this may simply succeed.
        assert not out.get("isError") or "batch_id" in _text(out)
    except RuntimeError as exc:
        msg = str(exc)
        # Reached the IDP tool (its validator answered) == connectivity OK.
        assert "batch_id" in msg or "ValidationException" in msg, msg
