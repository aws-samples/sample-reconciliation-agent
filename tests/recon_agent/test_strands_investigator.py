"""Strands agentic-loop investigator: trace assembly, tool capture, reference derivation.

Uses an injected fake agent factory so the loop is exercised without live Bedrock — the fake
agent (callable) invokes the registered gateway tools (to drive tool_call trace capture +
ledger-row accumulation) then returns a final message with the proposal JSON."""

import json

import pytest

from backend.harness_agent.intake import derive_notice_id
from backend.recon_core import email_policy
from backend.recon_core.schema import ReconItem
from llm import _matched_notice_id
from strands_investigator import (
    ProposalOut,
    _build_tools,
    _parse_proposal,
    _prompt,
    make_strands_investigator,
)

ITEM = ReconItem(
    item_id="idp-1",
    domain="loan-servicing",
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
                    "resolution": "Mark the draw cancelled.",
                    "confidence": 0.9,
                    "evidence": ["reference: DDTL-A-0001"],
                    "status": status,
                    "reason": "pushed",
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
        model_id="m",
        system="sys",
        tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=ledger),
    )
    out = invoke(ITEM, SKILLS)
    resolution, steps, action, draft = (
        out.resolution,
        out.steps,
        out.proposed_action,
        out.proposed_email,
    )

    assert draft is None  # this proposal carries no email_draft
    assert resolution == "Mark the draw cancelled."
    kinds = [s.kind for s in steps]
    assert "skill_load" in kinds and "tool_call" in kinds and kinds[-1] == "propose"
    tool_calls = [s for s in steps if s.kind == "tool_call"]
    assert {s.tool for s in tool_calls} == {"search_guidance", "search_ledger"}
    # Single clean ledger reference -> executable action derived by the worker (not the model).
    # `notice_id` is present but None: this investigation never called search_notices, so it cited no
    # notice. The key is written regardless so the interceptor can tell "cited nothing" from "cited
    # something unresolvable".
    #
    # The verdict is CLEAN even though this investigation consulted guidance: a playbook informs HOW the
    # work was done, not what it rests on, and this proposal rests on its single clean ledger reference.
    # An earlier design refused this case, which would have refused nearly every ledger-only resolution.
    assert action == {
        "tool": "set_draw_status",
        "reference": "DDTL-A-0001",
        "status": "Cancelled",
        "reason": "pushed",
        "item_id": "idp-1",
        "notice_id": None,
        "evidence_quality": "CLEAN",
        "evidence_quality_reason": (
            "no document evidence was cited; the proposal rests on the ledger alone"
        ),
    }


def test_ambiguous_ledger_yields_no_action():
    def tool_caller(name, args):
        if name == "search_ledger":
            return {"rows": [{"reference": "R1"}, {"reference": "R2"}]}
        return {}

    invoke = make_strands_investigator(
        model_id="m",
        system="sys",
        tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[]),
    )
    action = invoke(ITEM, SKILLS).proposed_action
    assert action is None  # 2 distinct refs -> nothing safely executable


def test_no_status_yields_no_action():
    def tool_caller(name, args):
        return {"rows": [{"reference": "DDTL-A-0001"}]} if name == "search_ledger" else {}

    invoke = make_strands_investigator(
        model_id="m",
        system="sys",
        tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[], status=None),
    )
    action = invoke(ITEM, SKILLS).proposed_action
    assert action is None  # confident single ref but no proposed status


def test_proposal_out_schema():
    p = ProposalOut(resolution="x")
    assert p.status is None and p.evidence == []


def test_parse_proposal_aliases_resolution_from_reason():
    """Parity with the harness intake safeguard: when the model drops `resolution` but supplies
    `reason`, reuse `reason` as the resolution narrative rather than persisting an empty string.
    `reason` is still retained for the proposed_action derivation."""
    out = _parse_proposal(
        json.dumps(
            {
                "status": "Cancelled",
                "reason": "Draw date pushed; cancel the draw.",
            }
        )
    )
    assert out.resolution == "Draw date pushed; cancel the draw."  # recovered from `reason`
    assert out.reason == "Draw date pushed; cancel the draw."  # still available for the action


def test_parse_proposal_degrades_when_no_resolution_or_reason():
    """When BOTH `resolution` and `reason` are absent, surface a clear degraded marker so the item
    escalates, instead of silently persisting an empty resolution.

    A stale S3 prompt can still emit `confidence`; it is dropped, not stored, and the item escalates
    on the missing narrative alone — the score comes from `evidence_steps`, which is also absent here.
    """
    out = _parse_proposal(json.dumps({"confidence": 0.9, "evidence": ["x"]}))
    assert out.resolution == "(model produced no resolution — escalated for human review)"
    assert not hasattr(out, "confidence")
    assert out.evidence_steps is None  # nothing to score -> 0.0 -> escalate


# --- email_draft -> proposed_email ---------------------------------------------------------------

DRAFT = {
    "recipient_contact_id": "cp-cindermoor",
    "recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.",
    "template_id": "tpl-wire-reference",
    "variables": {"wire_date": "2026-08-03"},
}
RENDERED_SUBJECT = "Wire reference confirmation"
RENDERED_BODY = "Please confirm the reference on the 2026-08-03 wire."


class _Templates:
    """A TemplateStore stand-in serving the template ``DRAFT`` cites."""

    def get(self, *, template_id: str) -> dict:
        """Return the wire-reference template.

        :param template_id: the id the draft cited; ignored, since template lookup is the store's
            behaviour and not this module's.
        :returns: the template row.
        """
        return {
            "template_id": "tpl-wire-reference",
            "subject_template": "Wire reference confirmation",
            "body_template": "Please confirm the reference on the {{wire_date}} wire.",
            "variables": ["wire_date"],
        }


@pytest.fixture(autouse=True)
def _stub_template_store(monkeypatch) -> None:
    """Point the shared draft helper at the stand-in store for every test in this module.

    The investigator calls ``build_persisted_draft`` exactly as production does, with no ``templates``
    argument, so the seam has to be the module function rather than a keyword the caller could forget.

    :param monkeypatch: pytest's patching fixture.
    :returns: None.
    """
    monkeypatch.setattr(email_policy, "_template_store", lambda: _Templates())


def _invoke_with_draft(email_draft):
    """Run the loop with the fake model emitting ``email_draft``, and return the persisted draft."""

    def tool_caller(name, args):
        return {"rows": [{"reference": "DDTL-A-0001"}]} if name == "search_ledger" else {}

    invoke = make_strands_investigator(
        model_id="m",
        system="sys",
        tool_caller=tool_caller,
        agent_factory=_fake_factory(ledger_rows=[], email_draft=email_draft),
    )
    return invoke(ITEM, SKILLS).proposed_email


def test_an_email_draft_becomes_a_pending_proposed_email():
    draft = _invoke_with_draft(DRAFT)
    assert draft["draft_status"] == "pending"
    assert draft["revision"] == 0 and draft["approved_revision"] is None
    # The operator's template rendered with the model's values — the model wrote neither string.
    assert draft["subject"] == RENDERED_SUBJECT and draft["body"] == RENDERED_BODY
    assert draft["recipient_hint"] == DRAFT["recipient_hint"]
    assert draft["recipient_contact_id"] == "cp-cindermoor"


def test_a_model_supplied_address_never_survives_into_the_draft():
    """The injection path the design closes: items come from documents an outside party wrote.

    The helper refuses the draft outright rather than stripping the address, and this module's policy
    is to drop a refused draft — so no route puts the address on the case.
    """
    draft = _invoke_with_draft({**DRAFT, "recipient": "attacker@evil.example"})
    assert draft is None


def test_an_incomplete_draft_is_dropped_without_failing_the_investigation(caplog):
    """This module fails toward human review, not toward a crash — the resolution still lands."""

    def tool_caller(name, args):
        return {}

    invoke = make_strands_investigator(
        model_id="m",
        system="sys",
        tool_caller=tool_caller,
        agent_factory=_fake_factory(
            ledger_rows=[], email_draft={"recipient_contact_id": "cp-cindermoor"}
        ),
    )
    out = invoke(ITEM, SKILLS)
    resolution, draft = out.resolution, out.proposed_email
    assert draft is None
    assert resolution == "Mark the draw cancelled."
    assert "discarding incomplete `email_draft`" in caplog.text


def test_a_non_object_email_draft_is_ignored(caplog):
    """A string where an object belongs is malformed, not a draft to coerce."""
    out = _parse_proposal(
        json.dumps(
            {
                "resolution": "x",
                "confidence": 0.5,
                "email_draft": "email the borrower",
            }
        )
    )
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

    tools = _build_tools(tool_caller, [], [], [])
    by_name = {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}
    by_name["search_correspondence"](**kwargs)
    assert len(tool_caller_seen) == 1
    name, args = tool_caller_seen[0]
    assert name == "search_correspondence"
    return args


def test_search_correspondence_builds_graph_openapi_args(monkeypatch):
    """search_correspondence maps to the microsoft-graph OpenAPI op listSharedMailboxMessages:
    it must send mailboxAddress (from GRAPH_MAILBOX) + $search + $top, and nothing else.

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

    tools = _build_tools(tool_caller, trace if trace is not None else [], [], [])
    return {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}


def test_every_offered_tool_is_a_read_and_none_of_them_sends(monkeypatch):
    """The withheld-tool invariant, asserted as an exact set so an addition cannot slip in.

    No send tool belongs here, and the interceptor's confirmation gate denying every
    model-originated send is not a reason to add one: being refused is not a workflow. A counterparty
    email is data the model puts in the proposal's `email_draft`, and the BFF sends the revision a
    human approved. If a send tool ever appears here, this fails.
    """
    monkeypatch.setenv("GRAPH_MAILBOX", "loan-ops@example.com")
    assert set(_tools([])) == {
        "search_ledger",
        "search_notices",  # the actual side; read-only, and there is no notices write tool
        "search_guidance",
        "search_correspondence",
        # Reads that let a draft CITE a recipient and a wording. Neither widens what the model can
        # see: list_contacts answers without the address column, and list_templates answers with the
        # {{placeholders}} unsubstituted.
        "list_contacts",
        "list_templates",
        # Gateway-prefixed aliases, so the names the SKILL.md files cite also resolve here.
        "general-ledger___search_ledger",
        "notices___search_notices",
        "managed-kb___Retrieve",
        "microsoft-graph___listSharedMailboxMessages",
        # Two prefixes for one Lambda, because the prefix is the gateway TARGET name.
        "contacts___list_contacts",
        "templates___list_templates",
    }


def test_the_contact_and_template_reads_go_to_the_two_separate_gateway_targets():
    """Both aliases must resolve to their OWN gateway tool name, not to a shared prefix.

    ``list_templates`` reaching the gateway as ``contacts___list_templates`` fails as an unknown tool,
    because the prefix is the TARGET name and there are two targets. The failure surfaces to the model
    as an opaque MCP error mid-investigation, so it is worth pinning here rather than discovering live.

    :returns: None.
    """
    seen: list = []
    tools = _tools(seen)
    tools["contacts___list_contacts"](kind="counterparty")
    tools["templates___list_templates"](purpose="counterparty")
    # The short name is what `_call` records; gateway_mcp maps it to the prefixed form.
    assert [n for n, _ in seen] == ["list_contacts", "list_templates"]
    assert [a for _, a in seen] == [{"kind": "counterparty"}, {"purpose": "counterparty"}]

    from gateway_mcp import gateway_tool_name

    assert gateway_tool_name("list_contacts") == "contacts___list_contacts"
    assert gateway_tool_name("list_templates") == "templates___list_templates"


def test_graph_tools_fail_loudly_when_the_mailbox_is_unconfigured(monkeypatch):
    """An empty mailboxAddress reaches Graph as /users//messages and returns a bare 404, which
    reads like a missing message rather than a missing configuration — raise instead."""
    monkeypatch.delenv("GRAPH_MAILBOX", raising=False)
    tools = _tools([])
    with pytest.raises(ValueError, match="GRAPH_MAILBOX"):
        tools["search_correspondence"](query="DDTL-A-0001")
    with pytest.raises(ValueError, match="GRAPH_MAILBOX"):
        tools["microsoft-graph___listSharedMailboxMessages"](query="DDTL-A-0001")


# ---------------------------------------------------------------------------------
# Tier-1's classification, as a HINT on the investigation prompt
# ---------------------------------------------------------------------------------

_SKILLS = [
    {"name": "record-match-review", "body": "compare the two records"},
    {"name": "unknown", "body": "gather context and escalate"},
]


def test_the_tier1_class_is_offered_as_a_hint_the_agent_may_reject():
    """Wording matters: this is the whole difference between a hint and a constraint.

    Tier-1 sees only the item's shape, so the prompt has to say the agent may disagree. A directive
    ("use skill X") would make the deterministic rule table the real classifier while leaving the
    agent's own classification in the record as though it had decided.
    """
    from strands_investigator import _class_hint_block

    block = _class_hint_block(
        attributes={"tier1_break_type": "record-match-review"}, skills=_SKILLS
    )
    assert "record-match-review" in block
    assert "hint" in block.lower()


def test_no_hint_block_when_tier1_did_not_classify():
    from strands_investigator import _class_hint_block

    assert _class_hint_block(attributes={}, skills=_SKILLS) == ""
    assert _class_hint_block(attributes={"tier1_break_type": ""}, skills=_SKILLS) == ""


def test_a_class_naming_no_loaded_skill_is_dropped():
    """A stale or hand-edited value must not be interpolated into a prompt.

    `tier1_break_type` comes off a stored DynamoDB item — written by an older deploy, a manual
    submission, or the Cases UI — so it is untrusted text. Naming a skill the agent was not given
    would also point it at a procedure it cannot read.
    """
    from strands_investigator import _class_hint_block

    assert _class_hint_block(attributes={"tier1_break_type": "deleted-skill"}, skills=_SKILLS) == ""
    assert _class_hint_block(attributes={"tier1_break_type": 7}, skills=_SKILLS) == ""


def test_the_hint_reaches_the_investigation_prompt():
    from strands_investigator import _prompt

    from backend.recon_core.schema import ReconItem

    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[],
        attributes={"tier1_break_type": "record-match-review"},
    )
    text = _prompt(item, _SKILLS, None)
    assert "Tier-1" in text and "record-match-review" in text


def test_the_prompt_names_the_declared_evidence_step_ids() -> None:
    """The model cannot report ids it was never shown, and it will invent plausible ones instead.

    ``parse_skill`` strips the front matter out of ``body``, so the declared ids reach the model only
    if the prompt puts them back explicitly. Asking for ``"step_id": "<id from your skill's evidence
    steps>"`` while showing no id anywhere is the trap, and "in the order listed" then points at a
    list the model cannot see. What that produces live: ``account_name_match`` — read off the skill's
    PROSE, which says "Account name" — for a skill declaring ``expected_entry_match``, and the whole
    investigation is discarded. Asserted on ``_prompt`` rather than on the block helper because what
    matters is the block being PRESENT in the prompt.

    :returns: None.
    """
    from strands_investigator import _prompt

    from backend.recon_core.schema import EvidenceStep, ReconItem

    skills = [
        {
            "name": "record-match-review",
            "body": "compare the two records",
            "evidence_steps": [
                EvidenceStep(id="fund_alias_match", description="resolve the fund label"),
                EvidenceStep(id="prior_lesson", description="check lessons", required=False),
            ],
        }
    ]
    text = _prompt(ReconItem(item_id="i-1", domain="cash", sides=[]), skills, None)

    assert "fund_alias_match" in text
    # Required vs optional is stated: only required steps are the denominator, so an agent spending a
    # tool call on the optional one instead scores lower for no gain.
    assert "required" in text and "optional" in text
    assert "prior_lesson" in text


def test_both_backends_derive_the_same_notice_id() -> None:
    # The two backends must be bit-identical here: a divergence surfaces only much later, as an
    # interceptor denial on whichever backend happened to run that case.
    rows = [{"notice_id": "n1"}, {"notice_id": "n1"}]
    assert _matched_notice_id(rows) == derive_notice_id({"search_notices": [{"rows": rows}]})


def test_both_backends_agree_that_two_notices_cite_nothing() -> None:
    # The interesting half of the agreement: ambiguity must collapse to None on BOTH sides, or one
    # backend proposes a citation the other refuses to make.
    rows = [{"notice_id": "a"}, {"notice_id": "b"}]
    assert _matched_notice_id(rows) is None
    assert derive_notice_id({"search_notices": [{"rows": rows}]}) is None


def test_the_runtime_backend_records_notice_rows_for_the_citation():
    """The citation is derived from what search_notices RETURNED, not from the model's proposal."""
    notice_rows: list[dict] = []

    def tool_caller(name, args):
        return {"rows": [{"notice_id": "NTC-1"}]} if name == "search_notices" else {"rows": []}

    tools = _build_tools(tool_caller, [], [], notice_rows)
    by_name = {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}
    # Called under its CANONICAL gateway name, which delegates — proving the alias is covered too.
    by_name["notices___search_notices"](counterparty="ACME")
    assert _matched_notice_id(notice_rows) == "NTC-1"


def test_reported_evidence_steps_reach_the_trace_before_the_propose_step():
    """End-to-end on the runtime path: prompt asks, parser keeps, loop records — in work order.

    The scoring in ``agent.score_by_evidence`` reads these entries off the trace. If any link breaks
    (the prompt not asking for `evidence_steps`, `_parse_proposal` dropping them, the loop not
    extending the trace), every runtime proposal silently scores 0.0 and nothing ever auto-resolves.
    """

    def factory(model_id, system_prompt, tools):
        class _FakeResult:
            def __init__(self, text):
                self.message = {"role": "assistant", "content": [{"text": text}]}

        class _FakeAgent:
            def __call__(self, prompt):
                # The contract must be IN the first-message prompt: the runtime model has no schema
                # forced on it, so this is the only place it can learn to emit the field.
                assert '"evidence_steps"' in prompt
                return _FakeResult(
                    json.dumps(
                        {
                            "resolution": "Mark the draw cancelled.",
                            "confidence": 0.9,
                            "evidence": [],
                            "status": None,
                            "reason": "",
                            "evidence_steps": [
                                {
                                    "step_id": "ledger_hit",
                                    "satisfied": True,
                                    "note": "found DDTL-A-0001",
                                },
                                {"step_id": "notice_hit", "satisfied": False},
                            ],
                        }
                    )
                )

        return _FakeAgent()

    invoke = make_strands_investigator(
        model_id="m", system="sys", tool_caller=lambda n, a: {"rows": []}, agent_factory=factory
    )
    steps = invoke(ITEM, SKILLS).steps
    reported = [(s.step_id, s.satisfied) for s in steps if s.kind == "evidence_step"]
    assert reported == [("ledger_hit", True), ("notice_hit", False)]
    # Order matters for the case timeline: the work precedes the conclusion.
    kinds = [s.kind for s in steps]
    assert kinds.index("evidence_step") < kinds.index("propose")


def test_a_json_string_of_evidence_steps_survives_the_parser():
    """A strict `list[dict]` annotation on ProposalOut would raise here and lose the proposal."""
    out = _parse_proposal(
        json.dumps(
            {
                "resolution": "r",
                "confidence": 0.5,
                "evidence_steps": '[{"step_id": "a", "satisfied": true}]',
            }
        )
    )
    assert out.evidence_steps == '[{"step_id": "a", "satisfied": true}]'


def test_the_production_agent_sets_an_explicit_output_cap(monkeypatch) -> None:
    """The investigation loop must not run on Strands' default max_tokens.

    With no cap set, a 4-required-step break truncates mid-JSON on the final message. Strands raises
    ``MaxTokensReachedException`` instead of handing back the partial text, so the whole invocation
    returns 500 and the case is stranded in IN_PROGRESS — nothing downstream can recover a proposal
    that was never returned.

    :param monkeypatch: pytest fixture, used to stand in for the Strands classes.
    :returns: None.
    """
    import sys
    import types

    seen: dict = {}

    class _FakeBedrockModel:
        def __init__(self, **kwargs) -> None:
            """Record the model kwargs the factory chose.

            :param kwargs: whatever ``_default_agent_factory`` passed.
            :returns: None.
            """
            seen.update(kwargs)

    class _FakeAgent:
        def __init__(self, **kwargs) -> None:
            """Accept the agent kwargs without constructing anything real.

            :param kwargs: whatever ``_default_agent_factory`` passed.
            :returns: None.
            """

    # `_default_agent_factory` imports `strands` lazily inside the function, so the fakes only need
    # to be in sys.modules at call time.
    monkeypatch.setitem(sys.modules, "strands", types.SimpleNamespace(Agent=_FakeAgent))
    monkeypatch.setitem(
        sys.modules, "strands.models", types.SimpleNamespace(BedrockModel=_FakeBedrockModel)
    )

    from strands_investigator import INVESTIGATOR_MAX_TOKENS, _default_agent_factory

    _default_agent_factory("model-id", "system", [])

    assert seen["max_tokens"] == INVESTIGATOR_MAX_TOKENS
    # A cap below the default is worse than none: the point is headroom for the final proposal JSON,
    # which carries one evidence_steps entry per prescribed step plus prose and an optional email.
    assert INVESTIGATOR_MAX_TOKENS >= 8192
    # streaming=False is load-bearing too (pins the wire API to Converse) — assert it did not get
    # dropped while adding the cap.
    assert seen["streaming"] is False


def test_the_final_output_prompt_asks_for_no_confidence() -> None:
    """The model must not be asked to grade itself: the only confidence is computed from the trace,
    so a number here is either ignored (misleading to the model) or, worse, later believed."""
    text = _prompt(ITEM, [{"name": "record-match-review", "description": "d", "body": ""}], None)
    assert '"confidence"' not in text
    assert '"evidence_steps"' in text  # the SCORED field is still demanded


def test_a_model_supplied_confidence_is_dropped_not_stored() -> None:
    """The live prompt is read from S3, so a stale copy can still ask for the key after this deploys.
    Ignore it silently rather than failing the parse — the item must not escalate over a stray field."""
    out = _parse_proposal('{"resolution": "Mark cancelled", "confidence": 0.99, "status": null}')
    assert not hasattr(out, "confidence")
    assert out.resolution == "Mark cancelled"
