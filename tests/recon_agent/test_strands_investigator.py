"""Strands agentic-loop investigator: trace assembly, tool capture, reference derivation.

Uses an injected fake agent factory so the loop is exercised without live Bedrock — the fake
agent (callable) invokes the registered gateway tools (to drive tool_call trace capture +
ledger-row accumulation) then returns a final message with the proposal JSON."""

import json

import pytest

from backend.recon_core.schema import ReconItem
from strands_investigator import (
    ProposalOut,
    _build_tools,
    _parse_proposal,
    make_strands_investigator,
)

ITEM = ReconItem(
    item_id="idp-1", domain="loan-servicing",
    sides=[{"name": "ledger", "attributes": {"reference": "DDTL-A-0001"}}],
    attributes={"idp_class": "LoanDrawCancellationNotice"},
)
SKILLS = [{"name": "document-cross-reference", "body": "Look up the ledger and confirm."}]


def _fake_factory(*, ledger_rows, status="Cancelled", refs=("DDTL-A-0001",), email_draft=None):
    """Return an agent_factory whose structured_output calls tools then returns a proposal."""

    def factory(model_id, system_prompt, tools):
        by_name = {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}

        class _FakeResult:
            def __init__(self, text):
                self.message = {"role": "assistant", "content": [{"text": text}]}

        class _FakeAgent:
            def __call__(self, prompt):
                # Simulate the agentic loop: the model calls search_guidance then search_ledger,
                # then emits the final proposal JSON as its last message.
                by_name["search_guidance"](query="draw cancellation")
                by_name["search_ledger"](reference="DDTL-A-0001")
                final = {
                    "resolution": "Mark the draw cancelled.", "confidence": 0.9,
                    "evidence": ["reference: DDTL-A-0001"], "status": status, "reason": "pushed",
                }
                if email_draft is not None:
                    final["email_draft"] = email_draft
                return _FakeResult(json.dumps(final))

        return _FakeAgent()

    return factory


def test_agentic_loop_builds_trace_and_action():
    ledger = [{"reference": "DDTL-A-0001"}]

    def tool_caller(name, args):
        if name == "search_ledger":
            return {"rows": ledger}
        return {"ok": name}

    invoke = make_strands_investigator(
        model_id="m", system="sys", tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=ledger),
    )
    resolution, confidence, steps, action, draft = invoke(ITEM, SKILLS)

    assert draft is None  # this proposal carries no email_draft
    assert resolution == "Mark the draw cancelled."
    assert confidence == 0.9
    kinds = [s.kind for s in steps]
    assert "skill_load" in kinds and "tool_call" in kinds and kinds[-1] == "propose"
    tool_calls = [s for s in steps if s.kind == "tool_call"]
    assert {s.tool for s in tool_calls} == {"search_guidance", "search_ledger"}
    # Single clean ledger reference -> executable action derived by the worker (not the model).
    assert action == {
        "tool": "set_draw_status", "reference": "DDTL-A-0001", "status": "Cancelled",
        "reason": "pushed", "item_id": "idp-1",
    }


def test_ambiguous_ledger_yields_no_action():
    def tool_caller(name, args):
        if name == "search_ledger":
            return {"rows": [{"reference": "R1"}, {"reference": "R2"}]}
        return {}

    invoke = make_strands_investigator(
        model_id="m", system="sys", tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[]),
    )
    _, _, _, action, _ = invoke(ITEM, SKILLS)
    assert action is None  # 2 distinct refs -> nothing safely executable


def test_no_status_yields_no_action():
    def tool_caller(name, args):
        return {"rows": [{"reference": "DDTL-A-0001"}]} if name == "search_ledger" else {}

    invoke = make_strands_investigator(
        model_id="m", system="sys", tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[], status=None),
    )
    _, _, _, action, _ = invoke(ITEM, SKILLS)
    assert action is None  # confident single ref but no proposed status


def test_proposal_out_schema():
    p = ProposalOut(resolution="x", confidence=0.5)
    assert p.status is None and p.evidence == []


def test_parse_proposal_aliases_resolution_from_reason():
    """Parity with the harness intake safeguard: when the model drops `resolution` but supplies
    `reason`, reuse `reason` as the resolution narrative rather than persisting an empty string.
    `reason` is still retained for the proposed_action derivation."""
    out = _parse_proposal(json.dumps({
        "confidence": 0.7, "status": "Cancelled", "reason": "Draw date pushed; cancel the draw.",
    }))
    assert out.resolution == "Draw date pushed; cancel the draw."  # recovered from `reason`
    assert out.reason == "Draw date pushed; cancel the draw."  # still available for the action
    assert out.confidence == 0.7  # confidence preserved when we recover from `reason`


def test_parse_proposal_degrades_when_no_resolution_or_reason():
    """When BOTH `resolution` and `reason` are absent, surface a clear degraded marker + 0
    confidence so the item escalates, instead of silently persisting an empty resolution."""
    out = _parse_proposal(json.dumps({"confidence": 0.9, "evidence": ["x"]}))
    assert out.resolution == "(model produced no resolution — escalated for human review)"
    assert out.confidence == 0.0  # forced to escalate


# --- email_draft -> proposed_email ---------------------------------------------------------------

DRAFT = {
    "recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.",
    "subject": "Wire reference confirmation",
    "body": "Please confirm the reference on the 2026-08-03 wire.",
}


def _invoke_with_draft(email_draft):
    """Run the loop with the fake model emitting ``email_draft``, and return the persisted draft."""

    def tool_caller(name, args):
        return {"rows": [{"reference": "DDTL-A-0001"}]} if name == "search_ledger" else {}

    invoke = make_strands_investigator(
        model_id="m", system="sys", tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[], email_draft=email_draft),
    )
    return invoke(ITEM, SKILLS)[4]


def test_an_email_draft_becomes_a_pending_proposed_email():
    draft = _invoke_with_draft(DRAFT)
    assert draft["draft_status"] == "pending"
    assert draft["revision"] == 0 and draft["approved_revision"] is None
    assert draft["subject"] == DRAFT["subject"] and draft["body"] == DRAFT["body"]
    assert draft["recipient_hint"] == DRAFT["recipient_hint"]


def test_a_model_supplied_address_never_survives_into_the_draft():
    """The injection path the design closes: items come from documents an outside party wrote."""
    draft = _invoke_with_draft({**DRAFT, "recipient": "attacker@evil.example"})
    assert draft["recipient"] is None


def test_an_incomplete_draft_is_dropped_without_failing_the_investigation(caplog):
    """This module fails toward human review, not toward a crash — the resolution still lands."""
    def tool_caller(name, args):
        return {}

    invoke = make_strands_investigator(
        model_id="m", system="sys", tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[], email_draft={"subject": "no body"}),
    )
    resolution, _, _, _, draft = invoke(ITEM, SKILLS)
    assert draft is None
    assert resolution == "Mark the draw cancelled."
    assert "discarding incomplete `email_draft`" in caplog.text


def test_a_non_object_email_draft_is_ignored(caplog):
    """A string where an object belongs is malformed, not a draft to coerce."""
    out = _parse_proposal(json.dumps({
        "resolution": "x", "confidence": 0.5, "email_draft": "email the borrower",
    }))
    assert out.email_draft is None
    assert "expected an object" in caplog.text


def _seen_correspondence_args(tool_caller_seen: list, **kwargs) -> dict:
    """Invoke the `search_correspondence` wrapper and return the args it sent to the gateway.

    :param tool_caller_seen: list the stub tool_caller appends ``(name, args)`` tuples to.
    :param kwargs: keyword arguments forwarded to the wrapper (``query``, ``top``).
    :returns: the argument dict of the single recorded call.
    """
    def tool_caller(name, args):
        tool_caller_seen.append((name, args))
        return {"value": []}

    tools = _build_tools(tool_caller, [], [])
    by_name = {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}
    by_name["search_correspondence"](**kwargs)
    assert len(tool_caller_seen) == 1
    name, args = tool_caller_seen[0]
    assert name == "search_correspondence"
    return args


def test_search_correspondence_builds_graph_openapi_args(monkeypatch):
    """search_correspondence maps to the microsoft-graph OpenAPI op listSharedMailboxMessages:
    it must send mailboxAddress (from GRAPH_MAILBOX) + $search + $top, not the old {query, top}.

    `$search` must be DOUBLE-QUOTED: OData rejects a bare value containing a hyphen or a space
    (i.e. nearly every reconciliation reference) with a 400 that reaches the model only as an
    opaque "unhandled errors in a TaskGroup".
    """
    monkeypatch.setenv("GRAPH_MAILBOX", "loan-ops@example.com")
    args = _seen_correspondence_args([], query="DDTL-A-0001", top=5)
    assert args == {
        "mailboxAddress": "loan-ops@example.com",
        "$search": '"DDTL-A-0001"',
        "$top": 5,
    }


def test_search_correspondence_coerces_top_and_strips_inner_quotes(monkeypatch):
    """The `top: int` annotation is not enforced at runtime, so a model-supplied "10" must be
    coerced — the Gateway validates $top against the OpenAPI schema and rejects the string. Inner
    double quotes are dropped rather than escaped: they would break the OData literal."""
    monkeypatch.setenv("GRAPH_MAILBOX", "loan-ops@example.com")
    args = _seen_correspondence_args([], query='  say "hi" now  ', top="10")
    assert args["$top"] == 10 and isinstance(args["$top"], int)
    assert args["$search"] == '"say hi now"'


def _tools(seen: list, trace: list | None = None) -> dict:
    """Build the gateway tools over a recording stub tool_caller, keyed by tool name.

    :param seen: list the stub tool_caller appends ``(name, args)`` tuples to.
    :param trace: optional ReasoningStep list the tools append trace entries to.
    :returns: mapping of tool name (short AND gateway-prefixed aliases) to the callable.
    """
    def tool_caller(name, args):
        seen.append((name, args))
        return {"ok": True}

    tools = _build_tools(tool_caller, trace if trace is not None else [], [])
    return {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}


def test_every_offered_tool_is_a_read_and_none_of_them_sends(monkeypatch):
    """The withheld-tool invariant, asserted as an exact set so an addition cannot slip in.

    This backend used to offer a `send_mail` wrapper (plus a gateway-named alias) on the theory that
    the interceptor's confirmation gate would deny every model-originated send — which it did. The
    tool is gone because being refused is not a workflow: a counterparty email is data the model
    puts in the proposal's `email_draft`, and the BFF sends the revision a human approved. If a send
    tool ever comes back here, this fails.
    """
    monkeypatch.setenv("GRAPH_MAILBOX", "loan-ops@example.com")
    assert set(_tools([])) == {
        "search_ledger",
        "search_guidance",
        "get_results",
        "search_correspondence",
        # Gateway-prefixed aliases, so the names the SKILL.md files cite also resolve here.
        "general-ledger___search_ledger",
        "knowledge-base___search_guidance",
        "document-extraction___IDPTools___get_results",
        "microsoft-graph___listSharedMailboxMessages",
    }


def test_graph_tools_fail_loudly_when_the_mailbox_is_unconfigured(monkeypatch):
    """An empty mailboxAddress reaches Graph as /users//messages and returns a bare 404, which
    reads like a missing message rather than a missing configuration — raise instead."""
    monkeypatch.delenv("GRAPH_MAILBOX", raising=False)
    tools = _tools([])
    with pytest.raises(ValueError, match="GRAPH_MAILBOX"):
        tools["search_correspondence"](query="DDTL-A-0001")
    with pytest.raises(ValueError, match="GRAPH_MAILBOX"):
        tools["microsoft-graph___listSharedMailboxMessages"](query="DDTL-A-0001")
