"""Strands Agent SDK investigator — a real agentic loop over the gateway tools.

A Strands ``Agent`` autonomously decides which gateway tools to call — the four reads
(search_ledger, search_notices, search_guidance, search_correspondence) — iterating over them guided
by the skill library (reusable procedures, of which it invokes the relevant one(s)) plus prior
analyst lessons, and emits a structured proposal via ``structured_output``. Every tool it holds is
a read. The LEDGER write tool (set_draw_status) is NOT given to the investigation agent — the
confidence-gated write happens post-proposal in ``auto_resolve.autonomous_execute`` (defense in
depth: the model never holds the write). Outbound email is withheld the same way: a counterparty
message is DATA on the proposal (``email_draft``), and the send is the platform's act on the
revision a human approved.

Preserves the ``build_proposal`` contract:
``callable(item, skills) -> InvestigationResult``.
The executable ``proposed_action`` is derived ONLY from a single unambiguous ``search_ledger``
reference recorded during the loop — the model never picks the ledger reference (F1). For the same
reason ``proposed_email`` carries no address: the model names the counterparty, an analyst supplies
the address and approves the text, and only then may it be sent.
"""

import logging
import os
from datetime import datetime
from typing import Callable

from pydantic import BaseModel, Field

from backend.recon_core.confidence import coerce_step_reports
from backend.recon_core.email_policy import build_persisted_draft, coerce_email_draft
from backend.recon_core.schema import InvestigationResult, ReasoningStep, ReconItem
from backend.recon_core.skill_meta import evidence_step_block
from backend.recon_core.tier1_hint import read_hint
from llm import (
    PROPOSABLE_STATUSES,
    _item_summary,
    _lessons_block,
    _matched_notice_id,
    _matched_reference,
    _result_text,
    _summarize_tool_output,
    accumulated_usage,
)


class ProposalOut(BaseModel):
    """Structured proposal the Strands agent emits at the end of its loop."""

    resolution: str = Field(description="The specific proposed resolution for the item.")
    evidence: list[str] = Field(
        default_factory=list,
        description="Evidence values copied VERBATIM from the item or a tool result.",
    )
    status: str | None = Field(
        default=None,
        description=f"Proposed ledger status, one of {list(PROPOSABLE_STATUSES)}, or null if no write applies.",
    )
    reason: str = Field(default="", description="Short reason for the status change.")
    # Mirrors the harness's `evidence_steps` submit field so both backends score identically. Not
    # required: an absent report scores 0.0 and escalates, which loses nothing the human needs.
    #
    # Typed `object`, not `list[dict]`: this arrives from free-form model JSON, and the model has
    # been observed emitting arrays as JSON strings. A strict annotation would raise inside the
    # parser, discarding an otherwise-usable proposal; `coerce_step_reports` is the single place that
    # interprets the shape, and it degrades toward unattempted rather than toward satisfied.
    evidence_steps: object = Field(
        default=None,
        description=(
            "One entry per evidence step your skill prescribes: "
            '{"step_id": "...", "satisfied": true|false, "note": "..."}. `satisfied` is true ONLY '
            "if that step's tool call returned data answering it."
        ),
    )
    email_draft: dict | None = Field(
        default=None,
        description=(
            "Optional counterparty email to be reviewed and sent by a human: "
            '{"recipient_contact_id": "<an id from list_contacts>", "template_id": "<an id from '
            'list_templates>", "variables": {"<declared name>": "<value>"}, '
            '"recipient_hint": "<counterparty NAME, for the reviewer to cross-check>"}. Omit unless '
            "writing to the counterparty is genuinely the next step. You never supply an address and "
            "you never write the message text — the operator owns both."
        ),
    )


# Output cap for the investigation loop. Explicit because the DEFAULT is too small for this agent's
# final message: the proposal JSON carries one `evidence_steps` entry per prescribed step, the
# resolution prose, and an optional email body, and a four-step break exceeds the default mid-JSON.
# Strands raises `MaxTokensReachedException` there rather than returning the partial text, so the
# whole invocation 500s and the case is left in IN_PROGRESS with nothing to show — the truncation is
# not recoverable downstream, which is why the cap belongs here.
INVESTIGATOR_MAX_TOKENS: int = 16384


def _default_agent_factory(model_id: str, system_prompt: str, tools: list):
    """Production Strands Agent (Bedrock model + gateway tools).

    ``streaming=False`` pins the wire API to `Converse`. Strands' `BedrockModel` defaults to
    `ConverseStream`; nothing here consumes tokens incrementally (the trace is assembled from the
    recorded tool calls and the final message), so the container issues no streaming call at all.

    :param model_id: the Bedrock model id (inference profile) to run the loop on.
    :param system_prompt: the assembled system prompt.
    :param tools: the gateway tool callables the agent may invoke.
    :returns: a configured Strands ``Agent``.
    """
    from botocore.config import Config as BotocoreConfig
    from strands import Agent
    from strands.models import BedrockModel

    return Agent(
        model=BedrockModel(
            model_id=model_id,
            streaming=False,
            max_tokens=INVESTIGATOR_MAX_TOKENS,
            # Adaptive retry, for the reasons spelled out in `llm._default_json_caller` — the
            # investigation loop is the larger consumer of the two, so leaving it on legacy retry
            # would leave most of the token spend unpaced. 8 attempts for the same reason as there: a
            # 5-attempt budget was observed exhausting against a transient ServiceUnavailableException,
            # and a rejected Converse bills no tokens.
            boto_client_config=BotocoreConfig(retries={"mode": "adaptive", "max_attempts": 8}),
        ),
        system_prompt=system_prompt,
        tools=tools,
    )


# Closed vocabularies for the two guidance facets whose values live in the corpus sidecars
# (data/kb-seed/**/*.metadata.json). Both are validated rather than passed through, because the
# failure mode of a stale or invented value is SILENT: Bedrock's Retrieve applies the filter, nothing
# matches, and the call returns {"retrievalResults": []} with HTTP 200. The agent reads that as "no
# guidance exists for this break" and improvises. tests/recon_agent/test_guidance_filter.py asserts
# these sets against the actual corpus, so adding a document with a new value fails the build rather
# than quietly becoming unreachable.
#
# GUIDANCE_DOC_TYPES has a second, unenforced reader: the operator-facing form that names what may be
# uploaded into the knowledge base validates the facet it stamps against its own copy of this list
# (KB_DOC_TYPES in chatbot-app/frontend/src/lib/workflowTypes.ts, which omits "playbook" because a
# playbook is seeded by the reconciliation team, not uploaded). Nothing asserts the two agree, so
# widen them in the same change: a facet an upload can stamp but this filter does not accept is a
# document the agent will never retrieve, and the silent-empty-result failure above is exactly how
# that would present.
GUIDANCE_DOC_TYPES = frozenset({"playbook", "email", "email_attachment"})
GUIDANCE_BREAK_CLASSES = frozenset(
    {"timing", "tolerance", "aggregation", "missing_reference", "unknown"}
)

# Upper bound on `top_k`. The corpus is 15 documents; anything larger is token burn, and the point of
# the cap is that it RAISES rather than clamps -- a silent clamp teaches the model nothing.
MAX_GUIDANCE_RESULTS = 20


def _coerce_int(*, name: str, value) -> int:
    """Coerce a model-supplied integer argument, failing loudly on anything that is not one.

    Strands does not enforce the ``int`` annotation on a tool parameter at runtime, so a model that
    emits ``"20260701"`` hands this code a string. That matters here specifically: ``effective_date``
    is a Bedrock ``NUMBER`` attribute, and filtering a NUMBER against a JSON string matches nothing
    and returns HTTP 200 -- indistinguishable from an empty corpus.

    :param name: parameter name, for the error message.
    :param value: the value as supplied by the model.
    :returns: the value as an ``int``.
    :raises ValueError: when the value cannot be interpreted as an integer.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be an integer, got {value!r}") from None


def build_guidance_filter(
    *,
    doc_type: str = "",
    break_class: str = "",
    skill: str = "",
    message_id: str = "",
    since_date: int = 0,
) -> dict | None:
    """Assemble a Bedrock ``managedSearchConfiguration`` filter from typed guidance facets.

    Building the filter here rather than letting the model emit filter JSON is the whole point of
    the wrapper: every operator below is chosen for the attribute's declared TYPE, and choosing
    wrongly returns zero results without raising.

    :param doc_type: one of ``GUIDANCE_DOC_TYPES``, or '' for no constraint.
    :param break_class: one of ``GUIDANCE_BREAK_CLASSES``, or '' for no constraint.
    :param skill: a skill name (e.g. ``record-match-review``), or '' for no constraint. NOT
        validated against a fixed set -- the skill library is editable at runtime through the UI,
        so a closed vocabulary here would go stale on the next edit.
    :param message_id: an archived message id, or '' for no constraint.
    :param since_date: inclusive ``YYYYMMDD`` lower bound on ``effective_date``; 0 for no bound.
    :returns: the filter object, or ``None`` when no facet is set.
    :raises ValueError: on a value outside a closed vocabulary, or a malformed ``since_date``.
    """
    if doc_type and doc_type not in GUIDANCE_DOC_TYPES:
        raise ValueError(f"doc_type must be one of {sorted(GUIDANCE_DOC_TYPES)}, got {doc_type!r}")
    if break_class and break_class not in GUIDANCE_BREAK_CLASSES:
        raise ValueError(
            f"break_class must be one of {sorted(GUIDANCE_BREAK_CLASSES)}, got {break_class!r}"
        )

    clauses: list[dict] = []
    if doc_type:
        # STRING -> equals.
        clauses.append({"equals": {"key": "doc_type", "value": doc_type}})
    if break_class:
        # ⚠️ STRING_LIST -> listContains. NEVER equals. `equals` against a list attribute matches
        # nothing, and it fails by returning zero results rather than by raising -- which reads as
        # "there is no guidance for this break class". It would also, if it did match, exclude the
        # two cross-cutting playbooks (source-selection, autonomy-and-escalation) that carry ALL
        # five classes, i.e. it would hide the escalation policy exactly when it is needed.
        clauses.append({"listContains": {"key": "break_class", "value": break_class}})
    if skill:
        # STRING_LIST -> listContains, for the same reason as break_class.
        clauses.append({"listContains": {"key": "skill", "value": skill}})
    if message_id:
        clauses.append({"equals": {"key": "message_id", "value": message_id}})
    if since_date:
        bound = _coerce_int(name="since_date", value=since_date)
        # An 8-digit YYYYMMDD that is a REAL calendar date. Anything else is a caller bug worth
        # raising over, because every malformed form still compares numerically against
        # `effective_date` and so looks like a working filter: a 4-digit year ("2026") silently
        # admits the entire corpus, and a month-13 date (20261301) silently excludes all of 2026.
        try:
            datetime.strptime(str(bound), "%Y%m%d")
        except ValueError as exc:
            raise ValueError(
                f"since_date must be a YYYYMMDD calendar date or 0, got {since_date!r}"
            ) from exc
        clauses.append({"greaterThanOrEquals": {"key": "effective_date", "value": bound}})

    if not clauses:
        return None
    # ⚠️ A single clause is returned BARE. RetrievalFilter requires exactly one operator member per
    # object, and a one-element andAll is rejected by the API (minimum 2 items).
    return clauses[0] if len(clauses) == 1 else {"andAll": clauses}


def build_retrieve_arguments(
    *,
    query: str,
    doc_type: str = "",
    break_class: str = "",
    skill: str = "",
    message_id: str = "",
    since_date: int = 0,
    top_k: int = 0,
) -> dict:
    """Build the argument object the ``managed-kb___Retrieve`` gateway tool expects.

    ⚠️ The shape is NESTED, mirroring the Bedrock ``Retrieve`` request, because that is what the
    connector target's ``parameterOverrides`` generate -- they are JSONPaths into the API request
    ($.retrievalQuery.text, $.retrievalConfiguration.managedSearchConfiguration.filter, .../
    numberOfResults), not flat argument names. A flat ``{"query": ...}`` is rejected by the
    gateway's schema validation. ``retrievalQuery`` is the only required member, and
    ``retrievalConfiguration`` must be OMITTED rather than sent empty when there is nothing in it.

    :param query: the natural-language retrieval query.
    :param doc_type: see :func:`build_guidance_filter`.
    :param break_class: see :func:`build_guidance_filter`.
    :param skill: see :func:`build_guidance_filter`.
    :param message_id: see :func:`build_guidance_filter`.
    :param since_date: see :func:`build_guidance_filter`.
    :param top_k: passages to return, 1..``MAX_GUIDANCE_RESULTS``; 0 leaves the admin default.
    :returns: the ``tools/call`` arguments object.
    :raises ValueError: on a blank query, an out-of-range ``top_k``, or an invalid facet.
    """
    text = str(query).strip()
    if not text:
        # Bedrock rejects an empty retrievalQuery, but with a ValidationException that names the
        # API field rather than the tool argument -- so say it here, where the caller can act on it.
        raise ValueError("query must not be empty")

    managed_search: dict = {}
    retrieval_filter = build_guidance_filter(
        doc_type=doc_type,
        break_class=break_class,
        skill=skill,
        message_id=message_id,
        since_date=since_date,
    )
    if retrieval_filter is not None:
        managed_search["filter"] = retrieval_filter
    if top_k:
        count = _coerce_int(name="top_k", value=top_k)
        if not 1 <= count <= MAX_GUIDANCE_RESULTS:
            raise ValueError(
                f"top_k must be between 1 and {MAX_GUIDANCE_RESULTS} (or 0 for the default), "
                f"got {top_k!r}"
            )
        managed_search["numberOfResults"] = count

    arguments: dict = {"retrievalQuery": {"text": text}}
    if managed_search:
        arguments["retrievalConfiguration"] = {"managedSearchConfiguration": managed_search}
    return arguments


def _build_tools(
    tool_caller: Callable | None,
    trace: list,
    ledger_rows: list,
    notice_rows: list,
    # Optional because most callers do not care where guidance went — only the proposal path does, and
    # it passes its own list. `None` rather than `[]`: a mutable default would be shared across every
    # call and accumulate another investigation's citations into this one's verdict.
    guidance_results: list | None = None,
    # The WHOLE ``search_notices`` results, alongside the flattened ``notice_rows`` above. Optional for
    # the same reason as ``guidance_results``: only the proposal path persists them.
    notice_results: list | None = None,
) -> list:
    """Build the gateway tools as Strands @tool callables that record trace entries.

    Each call appends a ``tool_call`` ReasoningStep and, for the search tools, accumulates rows
    so the caller can afterwards derive the single clean ledger reference and the single cited
    notice. Both accumulations happen inside ``_call``, so the canonical ``{target}___{tool}``
    aliases — which delegate to the short-named wrappers — are covered without a second code path.
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
                skill=name,
                kind="tool_call",
                reasoning=f"Invoked {name}",
                tool=name,
                tool_input=args,
                tool_output=_summarize_tool_output(result),
            )
        )
        if name == "search_ledger" and isinstance(result, dict):
            ledger_rows.extend(result.get("rows", []) or [])
        if name == "search_notices" and isinstance(result, dict):
            notice_rows.extend(result.get("rows", []) or [])
        # The unflattened result too, one line from its sibling above so the two cannot drift. Kept
        # SEPARATE from `notice_rows` deliberately: that list is the evidence VERDICT's input, and the
        # persisted summary de-duplicates and caps rows, so sharing one list would let a display
        # concern move a verdict that gates a ledger write. No isinstance guard — `matched_on` and a
        # tool-level `error` live at the result level and are lost by flattening, and
        # `notice_search_summary` already skips anything that is not (or does not decode to) a dict.
        if name == "search_notices" and notice_results is not None:
            notice_results.append(result)
        # Guidance retrievals are accumulated too, and NOT because they are evidence — they are not.
        # They are recorded so the evidence verdict can SEE that a proposal leaned on guidance and
        # refuse it. Without this, citing only a playbook is indistinguishable from citing nothing,
        # which is a legitimately clean case, and the category error would score as clean.
        if name == "search_guidance" and isinstance(result, dict) and guidance_results is not None:
            guidance_results.extend(result.get("retrievalResults", []) or [])
        return result

    @tool
    def search_ledger(
        reference: str = "",
        borrower: str = "",
        facility: str = "",
        fund_code: str = "",
        loanx_id: str = "",
        min_amount: float = 0,
        max_amount: float = 0,
        date_from: str = "",
        date_to: str = "",
    ) -> dict:
        """Search the general ledger — the expected side — for postings matching these filters.

        Args:
            reference: document reference / id the posting settles.
            borrower: borrower name (substring match).
            facility: facility name (substring match).
            fund_code: fund/portfolio code, e.g. "FUND-DL-I". EXACT match, unlike borrower and
                       facility — a substring would also match FUND-DL-II.
            loanx_id: LoanX ID of the facility (exact match); resolve one via the facility
                      crosswalk first.
            min_amount: lowest amount to return.
            max_amount: highest amount to return.
            date_from: earliest value date (YYYY-MM-DD).
            date_to: latest value date (YYYY-MM-DD).
        """
        args = {
            k: v
            for k, v in {
                "reference": reference,
                "borrower": borrower,
                "facility": facility,
                "fund_code": fund_code,
                "loanx_id": loanx_id,
                "min_amount": min_amount or None,
                "max_amount": max_amount or None,
                "date_from": date_from,
                "date_to": date_to,
            }.items()
            if v
        }
        return _call("search_ledger", args)

    @tool
    def search_notices(
        counterparty: str = "",
        fund: str = "",
        reference: str = "",
        amount: str = "",
        amount_tolerance: str = "0",
        date_from: str = "",
        date_to: str = "",
        notice_class: str = "",
        activity_type: str = "",
    ) -> dict:
        """Search extracted counterparty notices — the actual side of the reconciliation.

        A field this notice's class never extracts comes back named in `fields_unavailable`. That is
        NOT a non-match: the notice is still a candidate, you just cannot compare that field. An
        empty `rows` list means searched-and-found-nothing; a read failure raises.

        Args:
            counterparty: counterparty name exactly as extracted from the notice.
            fund: fund/portfolio label — resolve aliases with your skill's alias table first.
            reference: exact wire/transaction reference on the notice.
            amount: amount to match, as a decimal STRING (e.g. "9640.18"), not a float.
            amount_tolerance: symmetric tolerance around amount, as a decimal string.
            date_from: earliest notice date (YYYY-MM-DD).
            date_to: latest notice date (YYYY-MM-DD).
            notice_class: e.g. "wire_confirmation" or "remittance_advice" — what KIND OF DOCUMENT
                this is, as the extraction classified it.
            activity_type: what the notice REPORTS, in the source's vocabulary: "Interest", "Rateset",
                "Rollover", "Commitment Fee", "Paydown". Not the same axis as notice_class. A notice
                that carries none (an aggregated advice, say) is still returned, with activity_type
                named in fields_unavailable.
        """
        args = {
            k: v
            for k, v in {
                "counterparty": counterparty,
                "fund": fund,
                "reference": reference,
                # A tolerance with no amount to centre on is a hard error in the tool, so drop it
                # rather than send a band the caller cannot have meant.
                "amount": amount,
                "amount_tolerance": amount_tolerance if amount else "",
                "date_from": date_from,
                "date_to": date_to,
                "notice_class": notice_class,
                "activity_type": activity_type,
            }.items()
            if v
        }
        return _call("search_notices", args)

    @tool
    def search_guidance(
        query: str,
        doc_type: str = "",
        break_class: str = "",
        skill: str = "",
        message_id: str = "",
        since_date: int = 0,
        top_k: int = 0,
    ) -> dict:
        """Retrieve reconciliation guidance and archived correspondence from the knowledge base.

        Args:
            query: the natural-language question to retrieve guidance for.
            doc_type: optional — "playbook" (methodology: how to reconcile this kind of break),
                      "email" (archived correspondence: what a counterparty actually said) or
                      "email_attachment" (a remittance advice, notice or schedule that arrived with
                      one). Omit to search all three. A playbook tells you what to do; an email is
                      precedent about a DIFFERENT item and never overrides the playbook.
            break_class: optional — timing | tolerance | aggregation | missing_reference | unknown.
            skill: optional — restrict to guidance tagged for a skill, e.g. "record-match-review".
            message_id: optional — narrow to one archived message and its attachments, e.g.
                        "MSG-20260703-RA88214". Attachments carry a copy of their parent's
                        message_id. Note the filter only narrows the candidates: an attachment that
                        does not match your query text can still be left out, so if you expected one
                        and did not get it, ask again with query text describing its contents.
            since_date: optional — YYYYMMDD inclusive lower bound on effective_date, for excluding
                        stale precedent. 0 applies no bound.
            top_k: optional — passages to return (1-20); 0 leaves the default of 5.

        Returns:
            The Retrieve response, {"retrievalResults": [{"content": {"text": ...},
            "metadata": {...}, "score": ...}, ...]}. An EMPTY list means the filters matched
            nothing, not that no guidance exists — widen by dropping the narrowest facet.
        """
        args = build_retrieve_arguments(
            query=query,
            doc_type=doc_type,
            break_class=break_class,
            skill=skill,
            message_id=message_id,
            since_date=since_date,
            top_k=top_k,
        )
        return _call("search_guidance", args)

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

    @tool
    def list_contacts(kind: str = "counterparty") -> dict:
        """List the recipients the operator maintains, so a draft can cite one by id.

        No email address comes back from this tool, at any `kind`. The Lambda projects the address
        away before it answers, and the platform resolves the id to an address at send time. That is
        the point rather than an omission: reconciliation items arrive from documents an outside party
        wrote, so any address readable from one is an address that party chose.

        Args:
            kind: which list to read — ``counterparty`` for parties outside the operator (the only
                  kind a draft may cite), or ``internal_notification`` for the operator's own people.

        Returns:
            ``{"rows": [{"contact_id", "display_name", "kind", "active"}, ...], "count": n}`` —
            active rows only. An EMPTY list means the operator has not added anyone of that kind; say
            so in the resolution rather than inventing a recipient.
        """
        return _call("list_contacts", {"kind": kind})

    @tool
    def list_templates(purpose: str = "counterparty") -> dict:
        """List the message wordings the operator maintains, so a draft can cite one by id.

        You get each template's ``name`` and the ``variables`` it declares — not its subject or body.
        The wording is the operator's and the platform substitutes into it; you choose which template
        fits and supply values for exactly the names it declares.

        Args:
            purpose: ``counterparty`` for outbound asks, ``internal_notification`` for the operator's
                     own status mail.

        Returns:
            ``{"rows": [{"template_id", "name", "purpose", "variables", "active"}, ...],
            "count": n}``. If no template asks what the item needs asked, omit the draft and say so —
            an operator adds templates, and a near-miss sent verbatim is worse than none.
        """
        return _call("list_templates", {"purpose": purpose})

    # NOTE: there is deliberately NO send-mail tool here, and none of the gateway aliases below
    # exposes one. A counterparty email is written into the proposal's `email_draft` and sent later
    # by the BFF, from the revision a human approved. Do not add a `send_mail` wrapper here even one
    # whose docstring warns that the gateway will deny it: that asks the model to call a tool in order
    # to be refused, and every such refusal lands on the case trace as a denied outbound-email
    # attempt, which reads to a reviewer like the agent trying to mail a counterparty behind their
    # back. The agent drafts; a human sends.

    # Gateway-prefixed ALIASES: the SKILL.md files reference tools by their canonical gateway
    # names (general-ledger___search_ledger, ...). Register every tool under BOTH names so
    # whichever form the model uses resolves — tolerant tool-name matching on this backend.
    @tool(name="general-ledger___search_ledger")
    def search_ledger_gw(
        reference: str = "",
        borrower: str = "",
        facility: str = "",
        fund_code: str = "",
        loanx_id: str = "",
        min_amount: float = 0,
        max_amount: float = 0,
        date_from: str = "",
        date_to: str = "",
    ) -> dict:
        """Search the general ledger (canonical gateway name; same as search_ledger)."""
        return search_ledger(
            reference=reference,
            borrower=borrower,
            facility=facility,
            fund_code=fund_code,
            loanx_id=loanx_id,
            min_amount=min_amount,
            max_amount=max_amount,
            date_from=date_from,
            date_to=date_to,
        )

    @tool(name="notices___search_notices")
    def search_notices_gw(
        counterparty: str = "",
        fund: str = "",
        reference: str = "",
        amount: str = "",
        amount_tolerance: str = "0",
        date_from: str = "",
        date_to: str = "",
        notice_class: str = "",
        activity_type: str = "",
    ) -> dict:
        """Search extracted counterparty notices (canonical gateway name; same as search_notices)."""
        return search_notices(
            counterparty=counterparty,
            fund=fund,
            reference=reference,
            amount=amount,
            amount_tolerance=amount_tolerance,
            date_from=date_from,
            date_to=date_to,
            notice_class=notice_class,
            activity_type=activity_type,
        )

    @tool(name="managed-kb___Retrieve")
    def search_guidance_gw(
        query: str,
        doc_type: str = "",
        break_class: str = "",
        skill: str = "",
        message_id: str = "",
        since_date: int = 0,
        top_k: int = 0,
    ) -> dict:
        """Retrieve reconciliation guidance (canonical gateway name; same as search_guidance).

        ⚠️ Same TYPED signature as search_guidance, NOT the raw Retrieve request shape. The gateway
        advertises this tool with a nested inputSchema, but on this backend the wrapper builds that
        shape -- so a model calling the canonical name still passes flat facets, and never has to
        emit Bedrock filter JSON. (The harness backend has no wrapper and does emit it directly;
        that asymmetry is deliberate.)
        """
        return search_guidance(
            query=query,
            doc_type=doc_type,
            break_class=break_class,
            skill=skill,
            message_id=message_id,
            since_date=since_date,
            top_k=top_k,
        )

    @tool(name="microsoft-graph___listSharedMailboxMessages")
    def search_correspondence_gw(query: str, top: int = 10) -> dict:
        """Search the shared mailbox (canonical gateway name; same as search_correspondence)."""
        return search_correspondence(query=query, top=top)

    @tool(name="contacts___list_contacts")
    def list_contacts_gw(kind: str = "counterparty") -> dict:
        """List maintained recipients (canonical gateway name; same as list_contacts)."""
        return list_contacts(kind=kind)

    @tool(name="templates___list_templates")
    def list_templates_gw(purpose: str = "counterparty") -> dict:
        """List maintained message wordings (canonical gateway name; same as list_templates)."""
        return list_templates(purpose=purpose)

    return [
        search_ledger,
        search_notices,
        search_guidance,
        search_correspondence,
        list_contacts,
        list_templates,
        search_ledger_gw,
        search_notices_gw,
        search_guidance_gw,
        search_correspondence_gw,
        list_contacts_gw,
        list_templates_gw,
    ]


def _class_hint_block(*, attributes: dict, skills: list[dict]) -> str:
    """Format Tier-1's break classification as an advisory prompt block ('' when there is none).

    A HINT, never a directive. Tier-1's rules (``backend/tier1/classify.py``) see only the item's
    shape — how many sides it has, its domain — so the wording has to leave the agent free to
    disagree. Making it an instruction would turn the rule table into the real classifier while the
    agent's own classification still went into the case record as though it had decided.

    The value is dropped unless it names one of the LOADED skills. It comes off a stored DynamoDB
    item that an older deploy, a manual submission or the Cases UI produced, so it is untrusted text
    heading for a prompt; and a class whose procedure the agent was not given is useless anyway.

    :param attributes: the item's attribute bag (reads ``tier1_break_type``).
    :param skills: the loaded skill records — the validation set for the hint.
    :returns: the prompt block, or '' when there is no usable hint.
    """
    break_type = read_hint(attributes=attributes)
    if not break_type or break_type not in {s["name"] for s in skills}:
        return ""
    return (
        f"\nTier-1's deterministic rules classified this break as `{break_type}` — a hint from a "
        "rules engine that sees only the item's shape, not its evidence. Start with that skill, but "
        "your own classification governs: if the evidence points elsewhere, say so and follow the "
        "evidence.\n"
    )


def _prompt(item: ReconItem, skills: list[dict], lessons: list[str] | None) -> str:
    """First-message prompt: the item, the loaded skill procedure(s), lessons, and the contract."""
    procedures = (
        "\n\n".join(f"## Skill: {s['name']}\n{s['body']}{evidence_step_block(s)}" for s in skills)
        or "(none)"
    )
    return (
        "Investigate this reconciliation item and propose a resolution. Use the tools to gather "
        "evidence — call them as many times as needed, then STOP and output your final proposal "
        "as a single JSON object (and nothing else after it).\n\n"
        # The hint is intended HERE (classification has already happened, independently), so the
        # tier1_* attributes stay in the serialized item alongside the explicit block below.
        f"Item:\n{_item_summary(item, include_tier1_hint=True)}\n{_lessons_block(lessons)}\n"
        f"{_class_hint_block(attributes=item.attributes or {}, skills=skills)}"
        "Your skill library — reusable procedures. These are NOT categories; use the one(s) "
        "relevant to THIS item and compose several when the evidence warrants (ignore the rest):\n"
        f"{procedures}\n\n"
        "Cite only evidence values that appear verbatim in the item or a tool result. Do NOT "
        "invent a ledger reference — it is derived from your search_ledger results. Only set a "
        f"status from {list(PROPOSABLE_STATUSES)} when a ledger write is clearly warranted.\n\n"
        "When the item can only be settled by asking the counterparty something, add an "
        "`email_draft`. You do NOT send it, you do NOT choose the address, and you do NOT write the "
        "message: call `contacts___list_contacts` for the recipient and "
        "`templates___list_templates` for the wording, then cite one of each by id and supply values "
        "for exactly the `variables` that template declares. The platform renders it and an analyst "
        "approves the send. Put the counterparty's name in `recipient_hint` so the reviewer can "
        "cross-check the contact you picked. Omit `email_draft` entirely when no outbound contact is "
        "needed.\n\n"
        'Final output — ONLY this JSON: {"resolution": "<specific proposed action>", '
        '"evidence": ["<value copied verbatim>"], '
        f'"status": "<one of {", ".join(PROPOSABLE_STATUSES)} or null>", "reason": "<short reason>", '
        '"email_draft": {"recipient_contact_id": "<id from list_contacts>", '
        '"template_id": "<id from list_templates>", "variables": {"<name>": "<value>"}, '
        '"recipient_hint": "<counterparty name>"} | null, '
        # The scored field. Mirrors the harness's `evidence_steps` submit property verbatim in
        # meaning — the runtime model learns the output shape from THIS prompt (there is no schema
        # forced on it), so an omission here would make every runtime proposal score 0.0.
        '"evidence_steps": [{"step_id": "<an exact id from your skill\'s prescribed steps above>", '
        '"satisfied": true|false, "note": "<one line on what was found>"}]}\n\n'
        "`evidence_steps` must have ONE entry per evidence step your skill prescribes, in the order "
        "listed there, using those ids verbatim — an id that is not on the list is discarded and "
        "the step it was meant to report counts as never attempted. `satisfied` is true ONLY if "
        "that step's tool call returned data answering it — not "
        "if you reasoned around it. Reporting a step you did not attempt as satisfied is the single "
        "most damaging error you can make here: the case may then be resolved with no human review."
    )


def _parse_proposal(text: str) -> ProposalOut:
    """Parse the agent's final JSON proposal into a ProposalOut (fail-soft to a degraded escalate).

    Mirrors the harness ``backend/harness_agent/intake.build_proposal`` resolution safeguard so
    both backends behave identically when the model drops the top-level ``resolution``: the model
    frequently supplies only ``reason`` (the ledger-overlay note) and omits the narrative. When
    ``resolution`` is absent but ``reason`` is present, reuse ``reason`` as the resolution narrative
    (``reason`` still flows to ``proposed_action`` downstream). When BOTH are absent, surface a
    clear degraded marker so the item escalates rather than persisting a silently
    empty resolution — the runtime has no HITL degrade loop, so it fails toward a review, not a crash.
    """
    from llm import extract_json

    try:
        d = extract_json(text)
    except ValueError:
        return ProposalOut(resolution=(text or "no proposal produced")[:500])
    status = d.get("status")
    if status not in PROPOSABLE_STATUSES:
        status = None
    resolution = str(d.get("resolution", "") or "").strip()
    reason = str(d.get("reason", "") or "").strip()
    if not resolution and reason:
        # Alias parity with the harness: recover the narrative from `reason` rather than
        # persisting an empty resolution. `reason` is retained below for the proposed_action.
        logging.getLogger(__name__).warning(
            "proposal: `resolution` absent — recovering it from `reason`"
        )
        resolution = reason
    elif not resolution:
        # No narrative at all: escalate loudly (degraded) instead of persisting an empty string.
        logging.getLogger(__name__).warning(
            "proposal: neither `resolution` nor `reason` present — degrading to escalate"
        )
        resolution = "(model produced no resolution — escalated for human review)"
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
            type(submitted_draft).__name__,
            submitted_draft,
        )
    return ProposalOut(
        resolution=resolution,
        evidence=[str(e) for e in (d.get("evidence") or [])],
        status=status,
        reason=reason,
        email_draft=email_draft or None,
        # Passed through UNVALIDATED on purpose: `coerce_step_reports` is the one place that decides
        # what a malformed report means (it degrades toward unattempted), and it must see the raw
        # value. Coercing or rejecting here would either raise on a JSON-string array the model has
        # been observed emitting, or duplicate that judgement in a second place.
        evidence_steps=d.get("evidence_steps"),
    )


def make_strands_investigator(
    *,
    model_id: str,
    system: str,
    lessons: list[str] | None = None,
    tool_caller: Callable | None = None,
    agent_factory: Callable | None = None,
    usages: list[dict] | None = None,
) -> Callable:
    """Build the ``fake_investigate`` callable for ``proposal.build_proposal`` (Strands loop).

    :param agent_factory: test seam — ``callable(model_id, system_prompt, tools) -> agent`` where
        ``agent(prompt)`` runs the agentic loop and returns an AgentResult (or str). Production
        uses Strands. We parse the final message JSON rather than the forced-tool
        ``structured_output`` (which is fragile on some Bedrock models, e.g. Nova).
    :param usages: an OPTIONAL caller-owned sink the loop's raw token-usage dict is appended to, for
        ``recon_core.token_usage.summarize_token_usage`` to fold in alongside the classification
        samples'. A SINK rather than a member of the returned ``InvestigationResult`` because the
        return type is pinned by ``build_proposal``'s ``callable(item, skills) ->
        InvestigationResult`` contract and ``build_proposal`` never hands that object back to the
        entrypoint — so a field there could not reach the code that stores it. It also puts the
        classification's k reports and this one in ONE list with no merge step to forget, which is the
        same reason ``trace``/``ledger_rows``/``notice_rows`` are caller-owned lists above. ``None``
        records nothing, for the tests and the ``reconcile_item`` path that do not measure cost.
    :returns: ``callable(item, skills) -> InvestigationResult``.
    """

    def _investigate(item: ReconItem, skills: list[dict]) -> InvestigationResult:
        trace: list[ReasoningStep] = []
        ledger_rows: list[dict] = []
        notice_rows: list[dict] = []
        # Whole results, for the persisted display record; `notice_rows` above feeds the verdict. See
        # the accumulation comment in `_build_tools._call` for why these are two lists and not one.
        notice_results: list[dict] = []
        guidance_results: list[dict] = []
        # Record the skill library made available to the agent (it invokes the relevant one(s)).
        for s in skills:
            trace.append(
                ReasoningStep(
                    skill=s["name"],
                    kind="skill_load",
                    reasoning=f"Skill available: {s['name']}",
                )
            )
        tools = _build_tools(
            tool_caller, trace, ledger_rows, notice_rows, guidance_results, notice_results
        )
        agent = (agent_factory or _default_agent_factory)(model_id, system, tools)
        # Run the agentic loop (the agent autonomously calls the read tools), then parse the
        # final JSON proposal from its last message.
        result = agent(_prompt(item, skills, lessons))
        if usages is not None:
            # ONE entry for the whole loop, not one per tool-calling turn: a Strands `Agent`
            # accumulates usage across the turns of its own run, so this single dict already covers
            # every round trip the investigation made. Recorded before the parse so a malformed final
            # message — which `_parse_proposal` degrades rather than raises on — still books what the
            # loop burned getting there.
            usages.append(accumulated_usage(result))
        out: ProposalOut = _parse_proposal(_result_text(result))

        # The agent's per-step outcome reports become trace entries BEFORE the propose step, so the
        # case timeline reads in the order the work happened.
        trace.extend(coerce_step_reports(raw=out.evidence_steps, skill=item.domain or "propose"))

        trace.append(
            ReasoningStep(
                skill="propose",
                kind="propose",
                reasoning=out.resolution,
                evidence=list(out.evidence or []),
            )
        )

        matched_ref = _matched_reference(ledger_rows)
        matched_notice = _matched_notice_id(notice_rows)
        # Through the SHARED helper, so this backend and the harness reach the same verdict for the same
        # investigation. A divergence here would surface only much later, as a gateway denial on
        # whichever backend happened to run the item.
        from backend.recon_core.proposal_service import (
            judge_cited_evidence,
            notice_search_summary,
        )

        verdict, verdict_reason = judge_cited_evidence(
            notice_rows=notice_rows,
            guidance_results=guidance_results,
            workflow_types_table=os.environ.get("WORKFLOW_TYPES_TABLE", ""),
        )
        proposed_action = None
        if matched_ref and out.status in PROPOSABLE_STATUSES:
            proposed_action = {
                "tool": "set_draw_status",
                "reference": matched_ref,
                "status": out.status,
                "reason": out.reason or "",
                "item_id": item.item_id,
                # Derived, never model-supplied — same reason as `reference`. The interceptor gates
                # the ledger write on this notice's extraction confidence, so a
                # model-chosen id could nominate a clean notice while reasoning from a doubtful one.
                "notice_id": matched_notice,
                # Whether the cited evidence may be written from at all. Written unconditionally: at the
                # gateway an ABSENT verdict is a refusal, so a present one only means something if the
                # key is always there.
                "evidence_quality": verdict,
                "evidence_quality_reason": verdict_reason,
            }

        # Built through the shared helper both backends use, so the two persist an identical shape
        # (a divergence would only surface much later, as an interceptor denial at send time). The
        # helper renders the operator's template and refuses a draft that cites no contact or no
        # template, or that carries a literal address; that refusal is dropped with a warning rather
        # than raised, matching this module's documented policy of failing toward human review
        # instead of crashing the invocation. A template that fails to RENDER is not a refusal — it
        # comes back as a persisted draft marked render_failed, so the operator sees what to fix.
        proposed_email = None
        if out.email_draft:
            try:
                proposed_email = build_persisted_draft(email_draft=out.email_draft)
            except ValueError as exc:
                logging.getLogger(__name__).warning(
                    "proposal: discarding incomplete `email_draft` — %s", exc
                )

        return InvestigationResult(
            resolution=out.resolution,
            steps=trace,
            proposed_action=proposed_action,
            proposed_email=proposed_email,
            # Same shared derivation the harness backend uses, so the same investigation can never
            # show a different set of notices depending on which backend ran the item.
            notice_search=notice_search_summary(results=notice_results),
        )

    return _investigate
