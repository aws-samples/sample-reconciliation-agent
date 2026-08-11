"""Strands Agent SDK investigator — a real agentic loop over the gateway tools.

A Strands ``Agent`` autonomously decides which gateway tools to call — the four reads
(search_ledger, search_guidance, get_results, search_correspondence) — iterating over them guided
by the skill library (reusable procedures, of which it invokes the relevant one(s)) plus prior
analyst lessons, and emits a structured proposal via ``structured_output``. Every tool it holds is
a read. The LEDGER write tool (set_draw_status) is NOT given to the investigation agent — the
confidence-gated write happens post-proposal in ``auto_resolve.autonomous_execute`` (defense in
depth: the model never holds the write). Outbound email is withheld the same way: a counterparty
message is DATA on the proposal (``email_draft``), and the send is the platform's act on the
revision a human approved.

Preserves the ``build_proposal`` contract:
``callable(item, skills) -> (resolution, confidence, [ReasoningStep], proposed_action,
proposed_email)``.
The executable ``proposed_action`` is derived ONLY from a single unambiguous ``search_ledger``
reference recorded during the loop — the model never picks the ledger reference (F1). For the same
reason ``proposed_email`` carries no address: the model names the counterparty, an analyst supplies
the address and approves the text, and only then may it be sent.
"""

import logging
import os
from typing import Callable

from pydantic import BaseModel, Field

from backend.recon_core.email_policy import build_persisted_draft, coerce_email_draft
from backend.recon_core.schema import ReasoningStep, ReconItem
from llm import (
    PROPOSABLE_STATUSES,
    _item_summary,
    _lessons_block,
    _matched_reference,
    _result_text,
    _summarize_tool_output,
)


class ProposalOut(BaseModel):
    """Structured proposal the Strands agent emits at the end of its loop."""

    resolution: str = Field(description="The specific proposed resolution for the item.")
    confidence: float = Field(description="Overall confidence in the resolution, 0..1.")
    evidence: list[str] = Field(
        default_factory=list,
        description="Evidence values copied VERBATIM from the item or a tool result.",
    )
    status: str | None = Field(
        default=None,
        description=f"Proposed ledger status, one of {list(PROPOSABLE_STATUSES)}, or null if no write applies.",
    )
    reason: str = Field(default="", description="Short reason for the status change.")
    email_draft: dict | None = Field(
        default=None,
        description=(
            "Optional counterparty email to be reviewed and sent by a human: "
            '{"recipient_hint": "<counterparty NAME, not an address>", "subject": "…", '
            '"body": "…"}. Omit unless writing to the counterparty is genuinely the next step. '
            "You never supply an address — an analyst resolves it."
        ),
    )


def _default_agent_factory(model_id: str, system_prompt: str, tools: list):
    """Production Strands Agent (Bedrock model + gateway tools).

    ``streaming=False`` pins the wire API to `Converse`. Strands' `BedrockModel` defaults to
    `ConverseStream`; nothing here consumes tokens incrementally (the trace is assembled from the
    recorded tool calls and the final message), so the container issues no streaming call at all.
    """
    from strands import Agent
    from strands.models import BedrockModel

    return Agent(
        model=BedrockModel(model_id=model_id, streaming=False),
        system_prompt=system_prompt,
        tools=tools,
    )


def _build_tools(tool_caller: Callable | None, trace: list, ledger_rows: list) -> list:
    """Build the gateway tools as Strands @tool callables that record trace entries.

    Each call appends a ``tool_call`` ReasoningStep and (for search_ledger) accumulates rows so
    the caller can derive the single clean reference afterwards.
    """
    from strands import tool

    def _mailbox() -> str:
        """The deployment's shared mailbox address for the Graph ops.

        Fails loudly: an empty ``mailboxAddress`` reaches Graph as ``/users//messages`` and comes
        back a bare 404, which reads like a missing message rather than a missing configuration.

        :returns: the mailbox SMTP address from ``GRAPH_MAILBOX``.
        :raises ValueError: when ``GRAPH_MAILBOX`` is unset or blank.
        """
        mailbox = os.environ.get("GRAPH_MAILBOX", "").strip()
        if not mailbox:
            raise ValueError("GRAPH_MAILBOX is not configured for this runtime")
        return mailbox

    def _call(name: str, args: dict):
        result = tool_caller(name, args) if tool_caller is not None else "(no transport)"
        trace.append(
            ReasoningStep(
                skill=name, kind="tool_call", confidence=0.0, reasoning=f"Invoked {name}",
                tool=name, tool_input=args, tool_output=_summarize_tool_output(result),
            )
        )
        if name == "search_ledger" and isinstance(result, dict):
            ledger_rows.extend(result.get("rows", []) or [])
        return result

    @tool
    def search_ledger(reference: str = "", borrower: str = "", facility: str = "",
                      min_amount: float = 0, max_amount: float = 0,
                      date_from: str = "", date_to: str = "") -> dict:
        """Search the general ledger for postings matching a reference, borrower, facility, amount range, or date window."""
        args = {k: v for k, v in {
            "reference": reference, "borrower": borrower, "facility": facility,
            "min_amount": min_amount or None, "max_amount": max_amount or None,
            "date_from": date_from, "date_to": date_to,
        }.items() if v}
        return _call("search_ledger", args)

    @tool
    def search_guidance(query: str) -> dict:
        """Retrieve reconciliation guidance/playbook passages from the knowledge base."""
        return _call("search_guidance", {"query": query})

    @tool
    def get_results(document_id: str) -> dict:
        """Fetch the full IDP-extracted results for a single processed source document.

        The IDP MCP tool parameter is ``document_id`` (snake_case) — NOT ``documentId`` and NOT
        ``batch_id``. ``batch_id`` routes to the multi-document batch path and fails for a single
        document.
        """
        return _call("get_results", {"document_id": document_id})

    @tool
    def search_correspondence(query: str, top: int = 10) -> dict:
        """Search the shared mailbox (Microsoft Graph) for messages relevant to the item."""
        # Maps to the microsoft-graph OpenAPI op listSharedMailboxMessages (GET
        # /users/{mailboxAddress}/messages). The mailbox is fixed per deployment via GRAPH_MAILBOX;
        # the model only supplies the search text + count.
        #
        # Two OData details must be got right here, because both fail as an opaque MCP
        # "unhandled errors in a TaskGroup" that the model cannot self-correct from:
        #   - $search must be a DOUBLE-QUOTED string. Bare values containing a hyphen or a space
        #     (i.e. nearly every reconciliation reference) are an OData syntax error.
        #   - $top must be an int. The `top: int` annotation is NOT enforced at runtime, so a model
        #     that emits "10" would otherwise send a string and fail the Gateway's schema check.
        text = str(query).strip().replace('"', "")  # inner quotes would break the OData literal
        args = {
            "mailboxAddress": _mailbox(),
            "$search": f'"{text}"',
            "$top": int(top),
        }
        return _call("search_correspondence", args)

    # NOTE: there is deliberately NO send-mail tool here, and none of the gateway aliases below
    # exposes one. A counterparty email is written into the proposal's `email_draft` and sent later
    # by the BFF, from the revision a human approved. An earlier version of this file did offer a
    # `send_mail` wrapper whose docstring told the model the send would be denied at the gateway —
    # true, but it asked the model to call a tool in order to be refused, and every such refusal
    # landed on the case trace as a denied outbound-email attempt. The agent drafts; a human sends.

    # Gateway-prefixed ALIASES: the SKILL.md files reference tools by their canonical gateway
    # names (general-ledger___search_ledger, ...). Register every tool under BOTH names so
    # whichever form the model uses resolves — tolerant tool-name matching on this backend.
    @tool(name="general-ledger___search_ledger")
    def search_ledger_gw(reference: str = "", borrower: str = "", facility: str = "",
                         min_amount: float = 0, max_amount: float = 0,
                         date_from: str = "", date_to: str = "") -> dict:
        """Search the general ledger (canonical gateway name; same as search_ledger)."""
        return search_ledger(reference=reference, borrower=borrower, facility=facility,
                             min_amount=min_amount, max_amount=max_amount,
                             date_from=date_from, date_to=date_to)

    @tool(name="knowledge-base___search_guidance")
    def search_guidance_gw(query: str) -> dict:
        """Retrieve reconciliation guidance (canonical gateway name; same as search_guidance)."""
        return search_guidance(query=query)

    @tool(name="document-extraction___IDPTools___get_results")
    def get_results_gw(document_id: str) -> dict:
        """Fetch IDP-extracted results (canonical gateway name; same as get_results)."""
        return get_results(document_id=document_id)

    @tool(name="microsoft-graph___listSharedMailboxMessages")
    def search_correspondence_gw(query: str, top: int = 10) -> dict:
        """Search the shared mailbox (canonical gateway name; same as search_correspondence)."""
        return search_correspondence(query=query, top=top)

    return [search_ledger, search_guidance, get_results, search_correspondence,
            search_ledger_gw, search_guidance_gw, get_results_gw, search_correspondence_gw]


def _prompt(item: ReconItem, skills: list[dict], lessons: list[str] | None) -> str:
    """First-message prompt: the item, the loaded skill procedure(s), lessons, and the contract."""
    procedures = "\n\n".join(f"## Skill: {s['name']}\n{s['body']}" for s in skills) or "(none)"
    return (
        "Investigate this reconciliation item and propose a resolution. Use the tools to gather "
        "evidence — call them as many times as needed, then STOP and output your final proposal "
        "as a single JSON object (and nothing else after it).\n\n"
        f"Item:\n{_item_summary(item)}\n{_lessons_block(lessons)}\n"
        "Your skill library — reusable procedures. These are NOT categories; use the one(s) "
        "relevant to THIS item and compose several when the evidence warrants (ignore the rest):\n"
        f"{procedures}\n\n"
        "Cite only evidence values that appear verbatim in the item or a tool result. Do NOT "
        "invent a ledger reference — it is derived from your search_ledger results. Only set a "
        f"status from {list(PROPOSABLE_STATUSES)} when a ledger write is clearly warranted.\n\n"
        "When the item can only be settled by asking the counterparty something, add an "
        "`email_draft`. You do NOT send it and you do NOT choose the address: an analyst reviews "
        "the text, supplies the recipient and approves the send. Name the counterparty in "
        "`recipient_hint` and write the message as if it will be sent verbatim, because it will "
        "be. Omit `email_draft` entirely when no outbound contact is needed.\n\n"
        'Final output — ONLY this JSON: {"resolution": "<specific proposed action>", '
        '"confidence": <0..1>, "evidence": ["<value copied verbatim>"], '
        f'"status": "<one of {", ".join(PROPOSABLE_STATUSES)} or null>", "reason": "<short reason>", '
        '"email_draft": {"recipient_hint": "<counterparty name>", "subject": "<subject>", '
        '"body": "<message>"} | null}'
    )


def _parse_proposal(text: str) -> ProposalOut:
    """Parse the agent's final JSON proposal into a ProposalOut (fail-soft to a degraded escalate).

    Mirrors the harness ``backend/harness_agent/intake.build_proposal`` resolution safeguard so
    both backends behave identically when the model drops the top-level ``resolution``: the model
    frequently supplies only ``reason`` (the ledger-overlay note) and omits the narrative. When
    ``resolution`` is absent but ``reason`` is present, reuse ``reason`` as the resolution narrative
    (``reason`` still flows to ``proposed_action`` downstream). When BOTH are absent, surface a
    clear degraded marker + confidence 0 so the item escalates rather than persisting a silently
    empty resolution — the runtime has no HITL degrade loop, so it fails toward a review, not a crash.
    """
    from llm import extract_json

    try:
        d = extract_json(text)
    except ValueError:
        return ProposalOut(resolution=(text or "no proposal produced")[:500], confidence=0.0)
    status = d.get("status")
    if status not in PROPOSABLE_STATUSES:
        status = None
    resolution = str(d.get("resolution", "") or "").strip()
    reason = str(d.get("reason", "") or "").strip()
    confidence = float(d.get("confidence", 0.0) or 0.0)
    if not resolution and reason:
        # Alias parity with the harness: recover the narrative from `reason` rather than
        # persisting an empty resolution. `reason` is retained below for the proposed_action.
        logging.getLogger(__name__).warning(
            "proposal: `resolution` absent — recovering it from `reason`")
        resolution = reason
    elif not resolution:
        # No narrative at all: escalate loudly (degraded) instead of persisting an empty string.
        logging.getLogger(__name__).warning(
            "proposal: neither `resolution` nor `reason` present — degrading to escalate")
        resolution = "(model produced no resolution — escalated for human review)"
        confidence = 0.0
    # A JSON-object string is decoded (the harness model was seen emitting one; this parser reads
    # free-form model JSON, so it can happen here too). Anything else is malformed rather than a
    # draft, and is dropped with a warning rather than coerced — the item still escalates with its
    # resolution, and an analyst who needs to contact the counterparty can see from the log that the
    # model tried to. The value is logged truncated, because the type name alone cannot distinguish
    # prose-where-an-object-belongs from an object string that failed to parse.
    submitted_draft = d.get("email_draft")
    email_draft = coerce_email_draft(submitted_draft)
    if email_draft is None and submitted_draft:
        logging.getLogger(__name__).warning(
            "proposal: ignoring `email_draft` of type %s (expected an object): %.200r",
            type(submitted_draft).__name__, submitted_draft)
    return ProposalOut(
        resolution=resolution, confidence=confidence,
        evidence=[str(e) for e in (d.get("evidence") or [])], status=status,
        reason=reason, email_draft=email_draft or None,
    )


def make_strands_investigator(
    *,
    model_id: str,
    system: str,
    lessons: list[str] | None = None,
    tool_caller: Callable | None = None,
    agent_factory: Callable | None = None,
) -> Callable:
    """Build the ``fake_investigate`` callable for ``proposal.build_proposal`` (Strands loop).

    :param agent_factory: test seam — ``callable(model_id, system_prompt, tools) -> agent`` where
        ``agent(prompt)`` runs the agentic loop and returns an AgentResult (or str). Production
        uses Strands. We parse the final message JSON rather than the forced-tool
        ``structured_output`` (which is fragile on some Bedrock models, e.g. Nova).
    :returns: ``callable(item, skills) -> (resolution, confidence, [ReasoningStep], proposed_action)``.
    """

    def _investigate(item: ReconItem, skills: list[dict]):
        trace: list[ReasoningStep] = []
        ledger_rows: list[dict] = []
        # Record the skill library made available to the agent (it invokes the relevant one(s)).
        for s in skills:
            trace.append(
                ReasoningStep(skill=s["name"], kind="skill_load", confidence=0.0,
                              reasoning=f"Skill available: {s['name']}")
            )
        tools = _build_tools(tool_caller, trace, ledger_rows)
        agent = (agent_factory or _default_agent_factory)(model_id, system, tools)
        # Run the agentic loop (the agent autonomously calls the read tools), then parse the
        # final JSON proposal from its last message.
        out: ProposalOut = _parse_proposal(_result_text(agent(_prompt(item, skills, lessons))))

        trace.append(
            ReasoningStep(skill="propose", kind="propose", confidence=float(out.confidence),
                          reasoning=out.resolution, evidence=list(out.evidence or []))
        )

        matched_ref = _matched_reference(ledger_rows)
        proposed_action = None
        if matched_ref and out.status in PROPOSABLE_STATUSES:
            proposed_action = {
                "tool": "set_draw_status", "reference": matched_ref, "status": out.status,
                "reason": out.reason or "", "item_id": item.item_id,
            }

        # Built through the shared helper both backends use, so the two persist an identical shape
        # (a divergence would only surface much later, as an interceptor denial at send time). The
        # helper discards any address the model supplied and raises on a half-written draft; an
        # incomplete draft is dropped with a warning rather than raised, matching this module's
        # documented policy of failing toward human review instead of crashing the invocation.
        proposed_email = None
        if out.email_draft:
            try:
                proposed_email = build_persisted_draft(email_draft=out.email_draft)
            except ValueError as exc:
                logging.getLogger(__name__).warning(
                    "proposal: discarding incomplete `email_draft` — %s", exc)

        return out.resolution, float(out.confidence), trace, proposed_action, proposed_email

    return _investigate
