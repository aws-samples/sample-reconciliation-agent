"""Recon Agent entrypoint (single agent: classify AND reconcile).

Only invoked for items Tier-1 could not resolve. Classifies against the SKILL.md catalog
(with reasoning), loads the chosen type's skills, runs the investigation loop (with per-step
reasoning), builds a propose-only Proposal, and persists it as a PROPOSED case.
"""

import os
from decimal import Decimal

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

from classifier import pick_class
from proposal import build_proposal

from backend.recon_core.cases import CaseStore
from backend.recon_core.errors import ToolDenied
from backend.recon_core.schema import Proposal, ReconItem
from backend.recon_core.status import CaseStatus

# NOTE: IDP document lookup (get_results) is a gateway tool — the agent calls it over MCP through
# the egress gateway (gateway_mcp: document-extraction___IDPTools___get_results), like every other
# tool. The former direct-MCP idp_client.py was removed; there is no second IDP path.

app = BedrockAgentCoreApp()


def persist_proposal(*, cases: CaseStore, proposal: Proposal, advance: bool = True) -> None:
    """Attach the proposal (classification + per-step reasoning) to the case, then (when
    ``advance``) transition IN_PROGRESS -> PROPOSED (guarded). All float confidences → Decimal.

    ``advance=False`` re-attaches the proposal WITHOUT transitioning — used to re-persist after
    the autonomous write so the appended ``execute`` trace step is stored (the case is already
    PROPOSED by then; a second PROPOSED transition would be a guarded no-op)."""
    steps = [
        {
            "skill": s.skill,
            "confidence": Decimal(str(s.confidence)),
            "reasoning": s.reasoning,
            "evidence": s.evidence,
            "ts": s.ts,
            # Typed-trace fields (None-valued keys are dropped so old cases stay lean).
            **{
                k: v
                for k, v in {
                    "kind": s.kind,
                    "tool": s.tool,
                    "tool_input": s.tool_input,
                    "tool_output": s.tool_output,
                    "action": s.action,
                    "outcome": s.outcome,
                }.items()
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
        classification_confidence=Decimal(str(proposal.classification_confidence)),
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
    )
    if advance:
        cases.transition("item_id", proposal.item_id, CaseStatus.PROPOSED)


def reconcile_item(payload, *, _catalog, _classify, _investigate, _skills):
    """Core Tier-2 logic with injectable deps for tests. Classify then propose.

    ``_catalog`` is the SKILL.md catalog (NOT a DB registry). ``_classify`` returns
    ``(name, confidence, reasoning)``; ``_investigate`` returns
    ``(resolution, confidence, [ReasoningStep])``.
    """
    item = ReconItem.model_validate(payload["item"])
    classification = pick_class(catalog=_catalog, fake_llm=_classify)
    prop = build_proposal(
        item=item,
        classification=classification,
        fake_investigate=_investigate,
        skills=_skills,
    )
    return {**prop.model_dump(), "status": "PROPOSED"}


DEFAULT_SYSTEM_PROMPT = (
    "You are a reconciliation agent. Investigate exceptions rigorously; cite specific amounts, "
    "dates and references as evidence; report confidence honestly in [0,1]; propose only."
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

    The reads (search_ledger, search_guidance, get_results, search_correspondence) all go through
    the gateway like everything else; a tool failure degrades to an error dict so investigation
    continues (missing evidence lowers grounding → likelier escalation).

    A denial is tagged ``denied: true`` and carries the gateway's reason, because the two cases
    are read completely differently by whoever reviews the case: "refused by design, a human must
    approve this send" versus "the Graph target is broken". Both used to render as the same opaque
    error string."""
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
    """Production entrypoint (the formerly-stubbed Task 13b).

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
    model_id = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-5")
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

    # Self-consistency classification: k independent samples, majority vote. Agreement is the
    # strongest black-box confidence signal we have (see confidence.py). Each sample is a
    # single-turn Strands call — this container holds no bedrock-runtime client of its own.
    from llm import classify_with_consistency

    name, verbalized_cls, reasoning, consistency = classify_with_consistency(
        model_id=model_id, system=system, item=item, catalog=cat, lessons=lessons
    )
    classification = pick_class(
        catalog=cat, fake_llm=lambda _cat: (name, verbalized_cls, reasoning)
    )
    # Skills are a composable library, not one-of-N classes: give the agent the FULL set of skill
    # procedures so it can invoke one OR several to reconcile the item (mirrors the harness, which
    # is config-declared with every skill source). The classification above is retained only as a
    # calibration signal + case class_id — it does NOT restrict which skills the agent may run.
    skills = load([c["name"] for c in cat]) or load(["unknown"])
    prop = build_proposal(
        item=item,
        classification=classification,
        fake_investigate=make_strands_investigator(
            model_id=model_id, system=system, lessons=lessons,
            tool_caller=_make_tool_caller(),
        ),
        skills=skills,
    )

    # Replace the model's stated overall confidence with the COMPUTED composite that the
    # admin auto-resolve threshold compares against.
    from backend.recon_core.auto_resolve import get_threshold, maybe_auto_resolve
    from backend.recon_core.confidence import composite_confidence, evidence_grounding

    grounding = evidence_grounding(item=item, steps=prop.steps)
    idp_alerts = int(item.attributes.get("idp_confidence_alert_count") or 0)
    verbalized_overall = prop.confidence
    prop.confidence = composite_confidence(
        consistency=consistency,
        grounding=grounding,
        verbalized=verbalized_overall,
        idp_alerts=idp_alerts,
    )
    prop.confidence_components = {
        "consistency": consistency,
        "grounding": grounding,
        "verbalized": verbalized_overall,
        "idp_alerts": idp_alerts,
    }

    cases = CaseStore(
        table=os.environ.get("CASES_TABLE", "recon-cases"),
        audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
    )

    # Confidence-gated AUTONOMOUS execution: when the computed composite clears the admin
    # threshold AND there is a clean action, perform the write NOW (appending an `execute`
    # trace entry) and then take the full auto-resolve path. Below threshold, no clean action,
    # or a failed write => halt unactioned and escalate (PROPOSED) for human review.
    from backend.recon_core.auto_resolve import autonomous_execute

    threshold = get_threshold(os.environ.get("AUTO_RESOLVE_PARAM", ""))
    # Persist the proposal (-> PROPOSED) BEFORE the autonomous write: the set_draw_status tool's
    # server-side provenance gate reads the persisted proposed_action.reference off CASES_TABLE,
    # so it must exist before the gated write is attempted.
    persist_proposal(cases=cases, proposal=prop)
    outcome = autonomous_execute(
        proposal=prop, threshold=threshold, invoker=_make_write_invoker()
    )
    # Re-persist WITHOUT advancing so the `execute` trace step appended by autonomous_execute is
    # stored (the case is already PROPOSED).
    if any(getattr(s, "kind", None) == "execute" for s in prop.steps):
        persist_proposal(cases=cases, proposal=prop, advance=False)

    resolved = False
    if outcome == "executed":
        resolved = maybe_auto_resolve(cases=cases, proposal=prop, threshold=threshold)
    return {
        "item_id": item.item_id,
        "status": "RESOLVED" if resolved else "PROPOSED",
        "class_id": prop.class_id,
        "confidence": prop.confidence,
        "execution": outcome,
    }


if __name__ == "__main__":  # pragma: no cover
    app.run()
