"""Recon Agent entrypoint (single agent: classify AND reconcile).

Only invoked for items Tier-1 could not resolve. Classifies against the SKILL.md catalog
(with reasoning), loads the chosen type's skills, runs the investigation loop (with per-step
reasoning), builds a propose-only Proposal, and persists it as a PROPOSED case.
"""

import logging
import os
from decimal import Decimal

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

from classifier import pick_class
from proposal import build_proposal

from backend.recon_core.cases import CaseStore
from backend.recon_core.errors import ToolDenied
from backend.recon_core.schema import Proposal, ReasoningStep, ReconItem
from backend.recon_core.status import CaseStatus
from backend.recon_core.tier1_hint import read_hint

# NOTE: the agent has NO document-pipeline tool at all. What it needs about an extracted document —
# the per-section classification and the extracted field values — is already on recon's own notice
# row as `idp_sections`, which `notices___search_notices` returns. So a document lookup is an
# ordinary gateway read of recon's own storage, subject to the same interceptor as every other tool.

_LOG = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

# How long to wait for queued spans to reach the collector before giving up and returning anyway.
# Generous enough for a normal export, short enough that a wedged collector cannot hold a case
# hostage: the analyst's proposal matters more than its trace.
_TRACE_FLUSH_TIMEOUT_MS = 5_000


def flush_traces() -> None:
    """Export queued OTel spans before the container is frozen.

    ⚠️ Without this, most runtime-backend sessions emit exactly ONE span, and the failure is almost
    invisible. `opentelemetry-instrument` installs a `BatchSpanProcessor`, which queues spans and
    exports on a ~5s timer or once 512 are queued. AgentCore reclaims the container as soon as the
    entrypoint returns, so a short investigation returns with nearly everything still queued and
    those spans die with the container.

    The symptom is not "no traces at all", which is what makes it easy to miss. A long investigation
    looks perfectly healthy because the batch timer fires several times mid-run, so sessions with
    thousands of spans sit alongside sessions with exactly one. Online evaluation groups spans by
    session and cannot score a single span, so the short cases show "No evaluation recorded for this
    case" indefinitely while the long ones score normally — with the evaluation config, its role, its
    data source and its evaluators all correct.

    Never raises. A tracing failure must not fail an invocation that already produced a proposal --
    that would trade a missing trace for a lost case.
    """
    try:
        from opentelemetry import trace

        provider = trace.get_tracer_provider()
        # A NoOp provider is installed when the process runs without `opentelemetry-instrument`
        # (local runs, tests), and it has no force_flush. Absence here is normal, not an error.
        force_flush = getattr(provider, "force_flush", None)
        if callable(force_flush):
            force_flush(timeout_millis=_TRACE_FLUSH_TIMEOUT_MS)
    except Exception as exc:  # noqa: BLE001 - see docstring; tracing must not break the invocation
        _LOG.warning("span flush failed; this session's trace may be incomplete: %s", exc)


def persist_proposal(*, cases: CaseStore, proposal: Proposal, advance: bool = True) -> None:
    """Attach the proposal (classification + per-step reasoning) to the case, then (when
    ``advance``) transition IN_PROGRESS -> PROPOSED (guarded). All float confidences → Decimal.

    ``advance=False`` re-attaches the proposal WITHOUT transitioning, which is how the appended
    ``execute`` trace step gets stored after the autonomous write (the case is already PROPOSED by
    then; a second PROPOSED transition would be a guarded no-op)."""
    steps = [
        {
            "skill": s.skill,
            "reasoning": s.reasoning,
            "evidence": s.evidence,
            "ts": s.ts,
            # Typed-trace fields; None-valued keys are dropped so a stored trace stays lean.
            **{
                k: v
                for k, v in {
                    "kind": s.kind,
                    # Written by nobody, so always None. It sits inside this dropping block for
                    # exactly that reason — `Decimal(str(None))` raises.
                    "confidence": None if s.confidence is None else Decimal(str(s.confidence)),
                    "tool": s.tool,
                    "tool_input": s.tool_input,
                    "tool_output": s.tool_output,
                    "action": s.action,
                    "outcome": s.outcome,
                    "step_id": s.step_id,
                    "satisfied": s.satisfied,
                }.items()
                # `is not None` and NOT a truthiness test: `satisfied=False` (attempted, came back
                # empty) has to persist, while `satisfied=None` (never attempted) is correctly
                # absent — which is what the frontend's `boolean | null | undefined` reads.
                if v is not None
            },
        }
        for s in proposal.steps
    ]
    from backend.recon_core.proposal_service import to_decimal_safe

    steps = to_decimal_safe(steps)  # raw tool_input/tool_output may carry floats
    cases.attach_proposal(
        item_id=proposal.item_id,
        class_id=proposal.class_id,
        classification_reasoning=proposal.classification_reasoning,
        resolution=proposal.resolution,
        confidence=Decimal(str(proposal.confidence)),
        steps=steps,
        confidence_components={
            k: Decimal(str(v)) if isinstance(v, float) else v
            for k, v in (proposal.confidence_components or {}).items()
        },
        proposed_action=proposal.proposed_action,
        proposed_email=proposal.proposed_email,
        # Decimal-safe like `steps`: notice rows carry float `amount` and `extraction_confidence`, and
        # boto3 rejects raw Python floats.
        notice_search=to_decimal_safe(proposal.notice_search),
        # Read off the PROPOSAL rather than taken as an argument to this function, which is what makes
        # it survive the repeated writes: `handler` persists the same proposal twice (once to reach
        # PROPOSED before the gated write, once more to store the appended `execute` step), and an
        # argument would have to be re-supplied at each of them — one omission and the row silently
        # reverts to NULL, the failure `attach_proposal`'s note about this parameter describes.
        # `persist_and_execute` sets it once, before the first of those writes.
        # NOT run through `to_decimal_safe` — see the harness's persist for why the mapper's Decimals
        # must not be re-coerced here.
        token_usage=proposal.token_usage,
    )
    if advance:
        cases.transition("item_id", proposal.item_id, CaseStatus.PROPOSED)


def resolve_model_id(*, ssm=None) -> str:
    """Resolve the model id this invocation will ACTUALLY run on, live.

    Read PER INVOCATION, not once at import. This container is long-lived and warm-reused, so an
    import-time read would pin whichever model was selected when it started — exactly the staleness
    the live setting exists to remove. ``MODEL_ID`` is the fallback, so a fresh deploy and an
    unreachable parameter both behave as they did before.

    A module-level function rather than two lines inside :func:`handler` because the answer is stored:
    it labels the run's ``token_usage``, which is priced against it later. The entrypoint is untestable
    wiring, so a resolution living there could only be checked by inspection — and a hard-coded
    default is invisible in the stored row, which would simply carry a plausible id for a model that
    never ran.

    :param ssm: an SSM client, injected by tests; ``get_agent_model_id`` creates a real one when None.
    :returns: the model id to invoke, from the operator's SSM selection or the deployed default.
    """
    from backend.recon_core.model_select import get_agent_model_id

    return get_agent_model_id(
        os.environ.get("AGENT_MODEL_PARAM", ""),
        default=os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-5"),
        ssm=ssm,
    )


def persist_and_execute(
    *,
    cases: CaseStore,
    proposal: Proposal,
    usages: list[dict],
    model_id: str,
    threshold: float | None,
    invoker,
) -> tuple[str, bool]:
    """Attach the run's token usage, persist, run the gated write, re-persist, maybe auto-resolve.

    Extracted from :func:`handler` so the WHOLE tail of the runtime path is testable: it holds two
    writes and an unattended resolution, and every one of them has to carry the cost figure.

    Order matters. ``token_usage`` is set on the proposal FIRST, before any write — the proposal is
    persisted up to twice below, and ``maybe_auto_resolve`` closes the case without re-persisting it
    at all, so a value attached later would miss the very cases nobody ever reviews.

    :param cases: the case store holding the IN_PROGRESS case.
    :param proposal: the scored proposal; MUTATED (``token_usage``, and ``steps`` by the write).
    :param usages: every raw usage dict this invocation's model calls reported — the k classification
        samples' plus the investigation loop's. Summed here, once, by the shared mapper.
    :param model_id: the model this invocation actually ran on (:func:`resolve_model_id`). Required
        keyword with NO default, matching ``harness_agent.worker.run_investigation``: an operator can
        switch models from the Config tab, so a default here would mislabel — and therefore
        misprice — every run made after such a switch, with nothing downstream able to detect it.
    :param threshold: the admin auto-resolve threshold, or None when auto-resolution is off.
    :param invoker: ``callable(action: dict) -> result`` performing the gated ledger write.
    :returns: ``(execution outcome, whether the case was auto-resolved)``.
    """
    from backend.recon_core.auto_resolve import autonomous_execute, maybe_auto_resolve
    from backend.recon_core.token_usage import summarize_token_usage

    # k+1 model calls, ONE stored figure. `summarize_token_usage` — not a local sum — because the
    # harness backend writes the same field and the case screen shows one number without saying which
    # backend produced it, so a second summing implementation would be a second answer to "what does
    # `input_tokens` count".
    proposal.token_usage = summarize_token_usage(
        usages=usages, model_id=model_id, backend="runtime"
    )

    # Persist the proposal (-> PROPOSED) BEFORE the autonomous write: the set_draw_status tool's
    # server-side provenance gate reads the persisted proposed_action.reference off CASES_TABLE,
    # so it must exist before the gated write is attempted.
    persist_proposal(cases=cases, proposal=proposal)
    outcome = autonomous_execute(proposal=proposal, threshold=threshold, invoker=invoker)
    # Re-persist WITHOUT advancing so the `execute` trace step appended by autonomous_execute is
    # stored (the case is already PROPOSED). Carries `token_usage` unchanged — it rides on the
    # proposal, so this write cannot drop it.
    if any(getattr(s, "kind", None) == "execute" for s in proposal.steps):
        persist_proposal(cases=cases, proposal=proposal, advance=False)

    resolved = False
    if outcome == "executed":
        # APPROVED -> notification -> RESOLVED. It transitions status and never re-attaches the
        # proposal, so the usage an auto-resolved case carries is whatever the writes above stored —
        # which is why it is attached at the top of this function and not after the gate.
        resolved = maybe_auto_resolve(cases=cases, proposal=proposal, threshold=threshold)
    return outcome, resolved


def observed_tools_from(*, steps: list[ReasoningStep]) -> set[str]:
    """Collect the tools whose call completed with an output recorded, off the trace.

    Read off the trace rather than tracked separately because the trace is what gets persisted and
    reviewed: a second running tally could disagree with the record an analyst sees. Mirrors the
    harness's rule (``intake.build_proposal``, which reads ``StreamResult.tool_outputs``), so an
    identical investigation yields the identical observed set on both backends.

    SCOPE — what this can and cannot detect. The ``tool_output`` truthiness check filters an EMPTY
    recorded output, but the runtime's own producer (``strands_investigator._call``) serializes every
    result through ``json.dumps``, so a lookup that returned nothing still records ``"{}"`` /
    ``"null"`` and counts as observed; the harness appends its payload unconditionally and behaves
    the same. In practice, therefore, this means "a tool call ran and came back", NOT "a tool call
    yielded rows". That is enough for the only thing ``downgrade_unsupported_reports`` claims to
    catch — a proposal fabricated with no lookups at all — and it is deliberately the same on both
    backends. It does NOT catch a run whose every lookup came back empty; withholding credit there
    would need the per-step tool mapping the skill front matter does not carry.

    :param steps: the agent trace, including its ``tool_call`` entries.
    :returns: the short tool names with a non-empty recorded ``tool_output``.
    """
    return {s.tool for s in steps if s.tool and s.tool_output}


def score_by_evidence(
    *, prop: Proposal, skills: list[dict], observed_tools: set[str] | None = None
) -> None:
    """Replace the model's stated confidence with the COMPUTED evidence-completeness score.

    This is the number the admin auto-resolve threshold compares against: the fraction of the
    classified skill's REQUIRED prescribed steps whose tool call actually returned data. The model's
    own stated confidence is discarded because it is unfalsifiable — a claim about
    itself — whereas evidence completeness is checkable against the trace.

    ``satisfied`` is a model claim too, so completeness is only checkable to the extent the trace
    backs it. This is where that check happens: ``downgrade_unsupported_reports`` rewrites
    satisfied-claims to unattempted when no tool returned data at all. The harness does the same in
    ``intake.build_proposal``; without it here, the identical trace scores differently per backend —
    and the runtime's number is the one with no other check on it.

    Lives here, at module level, rather than inline in :func:`handler` — the entrypoint is untestable
    wiring, and the score that decides whether a ledger write happens unattended must be covered.

    Mutates ``prop`` in place (``confidence`` and ``confidence_components``), matching how the rest
    of the entrypoint threads the proposal through persistence and execution.

    :param prop: the proposal to re-score; mutated.
    :param skills: the loaded skills available to this investigation (``parse_skill`` dicts).
    :param observed_tools: short names of the tools that returned data during the investigation
        (``InvestigationResult.observed_tools``). ``None`` is treated as an empty set, which is the
        fail-safe reading: a caller that cannot say what the investigation observed has supplied no
        evidence that it observed anything.
    :returns: None.
    :raises ValueError: when the classified skill was not loaded, or its evidence-step declaration
        is malformed — see :func:`backend.recon_core.confidence.score_proposal`.
    """
    from backend.recon_core.confidence import downgrade_unsupported_reports, score_proposal

    prop.steps = downgrade_unsupported_reports(
        steps=prop.steps, observed_tools=observed_tools or set()
    )

    # The components go in exactly as the shared scorer produced them. Do not append extra diagnostic
    # terms alongside them: the case screen renders every component, so a term the gate does not use
    # still reaches the analyst as a number. A grounding fraction is the trap here — the agent cites
    # evidence as prose that never appears verbatim in the item, so it reads a permanent 0.00 next to
    # a case whose every prescribed step was in fact satisfied.
    prop.confidence, prop.confidence_components = score_proposal(
        skills=skills, class_id=prop.class_id, steps=prop.steps
    )


def reconcile_item(payload, *, _catalog, _classify, _investigate, _skills):
    """Core Tier-2 logic with injectable deps for tests. Classify then propose.

    ``_catalog`` is the SKILL.md catalog (NOT a DB registry). ``_classify`` returns
    ``(name, reasoning)``; ``_investigate`` returns an ``InvestigationResult``.
    """
    item = ReconItem.model_validate(payload["item"])
    classification = pick_class(
        catalog=_catalog,
        fake_llm=_classify,
        tier1_hint=read_hint(attributes=item.attributes or {}),
    )
    prop = build_proposal(
        item=item,
        classification=classification,
        fake_investigate=_investigate,
        skills=_skills,
    )
    return {**prop.model_dump(), "status": "PROPOSED"}


DEFAULT_SYSTEM_PROMPT = (
    "You are a reconciliation agent. Investigate exceptions rigorously; cite specific amounts, "
    "dates and references as evidence; report the evidence you actually obtained for each "
    "prescribed step; propose only."
)


def _read_s3_text(bucket: str, key: str) -> str | None:  # pragma: no cover - thin S3 wrapper
    """Read a small text object from S3; None when unavailable (falls back to the default)."""
    try:
        return boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read().decode()
    except Exception:  # noqa: BLE001 - missing prompt must not break the run
        return None


def _gateway_caller():  # pragma: no cover - thin transport wiring
    """Single Gateway-MCP tool transport shared by investigation reads AND the write/email.

    All tool calls go THROUGH the egress tools gateway (SigV4/AWS_IAM) so AgentCore Policy
    intercepts every one — the confidence gate on set_draw_status is enforced here by the
    gateway, not by app code. Requires RECON_GATEWAY_URL + AWS_REGION.
    """
    from gateway_mcp import make_gateway_tool_caller

    return make_gateway_tool_caller(
        gateway_url=os.environ["RECON_GATEWAY_URL"],
        region=os.environ.get("AWS_REGION", "us-east-1"),
    )


def _make_write_invoker():  # pragma: no cover - thin transport wrapper
    """Build the write invoker: call set_draw_status THROUGH the gateway (Policy-gated).

    Raises ToolDenied when the gateway/policy rejects the call (confidence below threshold) or
    RuntimeError on other failures — autonomous_execute records the outcome and escalates.
    """
    caller = _gateway_caller()

    def _invoke(action: dict):
        # Strip the transport key; pass the tool args (reference/status/reason/item_id/confidence).
        args = {k: v for k, v in action.items() if k != "tool"}
        return caller("set_draw_status", args)

    return _invoke


def _make_tool_caller():  # pragma: no cover - thin transport wrapper
    """Build the investigation tool transport — the shared Gateway-MCP caller.

    The reads (search_ledger, search_notices, search_guidance, search_correspondence) all go through
    the gateway like everything else; a tool failure degrades to an error dict so investigation
    continues (missing evidence lowers grounding → likelier escalation).

    A denial is tagged ``denied: true`` and carries the gateway's reason, because the two cases
    are read completely differently by whoever reviews the case: "refused by design, a human must
    approve this send" versus "the Graph target is broken". Collapsing them into one opaque error
    string makes a working policy decision indistinguishable from an outage."""
    caller = _gateway_caller()

    def _call(tool: str, args: dict):
        try:
            return caller(tool, args)
        except ToolDenied as exc:
            # Not a failure — the guardrail worked. Say so, in the trace, in the model's tool
            # result, and with the reason the gateway gave.
            return {"error": str(exc), "denied": True}
        except Exception as exc:  # noqa: BLE001 - a read failure must not abort investigation
            return {"error": str(exc)}

    return _call


@app.entrypoint
async def handler(payload, context):  # pragma: no cover - wiring, pure parts tested separately
    """Production entrypoint.

    Reads the live SKILL.md catalog + system prompt from S3 (editable via the Config/Skills UI,
    ~60s TTL; falls back to the baked-in SKILLS_DIR), runs **Strands**-backed self-consistency
    classification (llm.classify_with_consistency) then a **Strands Agent agentic loop**
    (strands_investigator) over the gateway tools guided by the loaded SKILL.md, proposes, and
    persists the PROPOSED case. The analyst reviews it.
    """
    from pathlib import Path

    from skills_loader import catalog, catalog_s3, load_skills, load_skills_s3
    from strands_investigator import make_strands_investigator

    item = ReconItem.model_validate(payload["item"])
    model_id = resolve_model_id()
    # Every model call this invocation makes appends its raw usage report here, in call order: k from
    # the self-consistency classifier below, one more from the investigation loop. k+1 entries, summed
    # once at the end by `persist_and_execute`. Reading only the investigation's — the single largest —
    # would report roughly a quarter of real spend at k=3 and look entirely plausible on screen.
    usages: list[dict] = []
    bucket = os.environ.get("ASSETS_BUCKET", "")
    prefix = os.environ.get("SKILLS_PREFIX", "skills/")

    # Live S3 skills + system prompt when configured; container-baked files otherwise.
    if bucket:
        cat = catalog_s3(bucket, prefix)
        system = (
            _read_s3_text(bucket, os.environ.get("SYSTEM_PROMPT_KEY", "system-prompt.md"))
            or DEFAULT_SYSTEM_PROMPT
        )
        load = lambda names: load_skills_s3(bucket, prefix, names=names)  # noqa: E731
    else:
        skills_dir = Path(os.environ.get("SKILLS_DIR", "skills"))
        cat = catalog(skills_dir)
        system = DEFAULT_SYSTEM_PROMPT
        load = lambda names: load_skills(skills_dir, names=names)  # noqa: E731

    # Recall prior analyst lessons for this domain from AgentCore Memory (advisory, fail-soft).
    from backend.recon_core.lessons_recall import retrieve_lessons

    lessons = retrieve_lessons(
        memory_id=os.environ.get("MEMORY_ID", ""),
        domain=item.domain,
        query=f"{item.item_id} {item.attributes.get('idp_class') or ''} reconciliation break",
    )

    from llm import classify_with_consistency

    # Self-consistency classification: k independent samples, majority vote. The vote returns the
    # class and its reasoning and no number — the auto-resolve gate scores evidence completeness
    # alone, and the agreement fraction is deliberately not a gate (over three samples it has four
    # possible values and no calibration behind them). Sampling k times still buys a more stable
    # label than one sample would, and the label picks the scoring denominator. Each
    # sample is a single-turn Strands call — this container holds no bedrock-runtime client of its own.
    #
    # Tier-1's `tier1_break_type` is deliberately NOT fed into this prompt: all k samples share one
    # prompt, so pointing them at an answer would collapse the vote to unanimous regardless of how
    # ambiguous the item really is. The hint belongs on the INVESTIGATION prompt, where the skill is
    # actually chosen (strands_investigator._class_hint_block), and on the disagreement log below.
    vote = classify_with_consistency(
        model_id=model_id, system=system, item=item, catalog=cat, lessons=lessons
    )
    # Every sample's usage, not just the last: these are k independent calls and each is billed.
    usages.extend(vote.usages)
    classification = pick_class(
        catalog=cat,
        fake_llm=lambda _cat: (vote.name, vote.reasoning),
        tier1_hint=read_hint(attributes=item.attributes or {}),
    )
    # Skills remain a composable library — the agent may run one OR several to reconcile the item
    # (mirrors the harness, which is config-declared with every skill source).
    skills = load([c["name"] for c in cat]) or load(["unknown"])
    prop = build_proposal(
        item=item,
        classification=classification,
        fake_investigate=make_strands_investigator(
            model_id=model_id,
            system=system,
            lessons=lessons,
            tool_caller=_make_tool_caller(),
            # The (k+1)-th report lands in the same list the classification samples went into.
            usages=usages,
        ),
        skills=skills,
    )

    from backend.recon_core.auto_resolve import get_threshold

    score_by_evidence(
        prop=prop, skills=skills, observed_tools=observed_tools_from(steps=prop.steps)
    )

    cases = CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )

    # Confidence-gated AUTONOMOUS execution plus persistence, including the run's token usage — see
    # `persist_and_execute`, which owns the ordering of the two writes and the unattended resolution.
    threshold = get_threshold(os.environ.get("AUTO_RESOLVE_PARAM", ""))
    outcome, resolved = persist_and_execute(
        cases=cases,
        proposal=prop,
        usages=usages,
        model_id=model_id,
        threshold=threshold,
        invoker=_make_write_invoker(),
    )
    # Last thing before returning: AgentCore freezes the container on return, taking any queued
    # spans with it. See flush_traces().
    flush_traces()
    return {
        "item_id": item.item_id,
        "status": "RESOLVED" if resolved else "PROPOSED",
        "class_id": prop.class_id,
        "confidence": prop.confidence,
        "execution": outcome,
    }


if __name__ == "__main__":  # pragma: no cover
    app.run()
