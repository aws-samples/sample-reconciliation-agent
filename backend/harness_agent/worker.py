"""Harness-backed agent worker: drive the InvokeHarness loop for one escalated item.

Selected by ``agent_worker.py`` when ``AGENT_BACKEND=="harness"``. The managed harness runs the
Strands loop; this worker owns the inline_function round-trip and all persistence/gating:

  1. build the first message (item + IDP class/confidence + lessons + workflow contract);
  2. InvokeHarness (stream) → assemble typed trace + gateway tool outputs;
  3. when the stream stops to run ``submit_proposal``: validate + derive the reference + compute
     the evidence-completeness confidence + persist the proposal (→ PROPOSED);
  4. on ``execute`` the WORKER performs the Policy-gated set_draw_status write through the
     egress gateway and resolves the case (APPROVED→RESOLVED + notification email +
     AUTO_RESOLVED lesson) via the SAME shared code the runtime backend uses
     (``recon_core.auto_resolve``). The model is propose-only on this backend: its allowed
     tools are reads + Graph email + ``submit_proposal`` — it never writes to the ledger.
     The final re-invoke carries the decision + outcome as the ``toolResult`` so the session
     closes with an informational summary turn (no side effects expected from the model).

Any failure (``timeout_exceeded`` / ``max_iterations_exceeded`` / malformed output / missing
submit_proposal / write denial) lands the case in PROPOSED — never stranded IN_PROGRESS.
``run_investigation`` takes an injected ``invoke(messages) -> iterable[events]`` transport so the
whole loop is unit-testable without AWS; ``handle`` wires the live InvokeHarness stream.
"""

import logging
import os

from backend.harness_agent import intake, prompting
from backend.harness_agent.stream import assemble_stream
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReasoningStep, ReconItem
from backend.recon_core.tier1_hint import read_hint

logger = logging.getLogger(__name__)

_FAILURE_STOPS = {"timeout_exceeded", "max_iterations_exceeded"}


def _assistant_tooluse_message(pending: dict) -> dict:
    """Reconstruct the assistant turn that requested the tool (for the re-invoke messages)."""
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": pending["toolUseId"],
                                 "name": pending["raw_name"], "input": pending["input"]}}],
    }


def _toolresult_message(tool_use_id: str, decision: dict) -> dict:
    """Build the user turn carrying the submit_proposal toolResult (the execute/escalate decision).

    The content part is ``text`` (a JSON string), NOT a bare ``json`` block. The managed harness
    runtime ("loopy") wraps a Strands ``Agent`` whose Bedrock model provider
    (``strands/models/bedrock.py:_format_request_message_content``) has no mapping for a ``json``
    content type and raises ``TypeError: content_type=<json_> | unsupported type`` — surfaced to
    us as a ``runtimeClientError`` EventStreamError that fails the closing re-invoke every time.
    ``json`` IS valid in the raw InvokeHarness toolResult schema, but Strands (one layer up)
    rejects it, so we serialize the decision to text instead. ``default=str`` mirrors the other
    ``json.dumps`` calls in this package and guards any non-native value defensively.
    """
    import json

    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success",
                                    "content": [{"text": json.dumps(decision, default=str)}]}}],
    }


def _persist_degraded(
    *, cases: CaseStore, item: ReconItem, steps, reason: str, now: str,
    class_id: str = "unknown",
) -> None:
    """Persist a degraded proposal (trace-so-far, no executable action) → PROPOSED.

    Used when no VALID proposal was produced (failure stop / missing submit_proposal / malformed
    output) so the item always leaves IN_PROGRESS for a human rather than being stranded. The
    resolution CONFIDENCE stays 0 (there is no trustworthy resolution), but the CLASSIFICATION is
    preserved when known — on a malformed proposal the model still typically supplied a valid
    ``class_name``, so collapsing it to ``unknown`` needlessly discards a correct classification
    (observed live 2026-07-27).

    :param class_id: preserved classification when known (default ``"unknown"``).
    """
    from backend.recon_core.schema import Proposal

    prop = Proposal(
        item_id=item.item_id, class_id=class_id,
        classification_reasoning=reason, resolution=reason, confidence=0.0,
        steps=list(steps) + [ReasoningStep(skill=class_id, kind="propose",
                                           reasoning=reason)],
        proposed_action=None,
    )
    intake.persist(cases=cases, proposal=prop)


def run_investigation(
    *, item: ReconItem, invoke, cases: CaseStore, catalog: list[dict],
    threshold, lessons=None, now: str = "", write_transport=None,
) -> str:
    """Drive the harness loop for one item. Returns 'executed' | 'escalated' | 'failed'.

    :param invoke: injected transport ``callable(messages) -> iterable[event dicts]`` (one
        InvokeHarness stream per call). Production wraps boto3 InvokeHarness streaming.
    :param write_transport: test seam for the worker's gateway write
        (``callable(tool_name, arguments) -> result``); None uses the live SigV4 MCP call.
    """
    messages = [prompting.build_first_message(item=item, catalog=catalog, lessons=lessons)]
    try:
        first = assemble_stream(invoke(messages))
    except Exception as exc:  # noqa: BLE001 - stream/transport failure must not strand the item
        logger.error("harness invoke failed for %s: %s", item.item_id, exc, exc_info=True)
        _persist_degraded(cases=cases, item=item, steps=[], reason=f"harness invoke failed: {exc}", now=now)
        return "failed"

    if first.stop_reason in _FAILURE_STOPS:
        logger.warning("harness stopped early for %s: %s", item.item_id, first.stop_reason)
        _persist_degraded(cases=cases, item=item, steps=first.steps,
                          reason=f"harness stopped: {first.stop_reason}", now=now)
        return "escalated"

    pending = first.pending_tool
    if not (pending and pending.get("name") == "submit_proposal"):
        logger.warning("harness did not submit a proposal for %s (pending=%s)",
                       item.item_id, pending.get("name") if pending else None)
        _persist_degraded(cases=cases, item=item, steps=first.steps,
                          reason="agent did not submit a proposal", now=now)
        return "escalated"

    logger.info("harness submit_proposal for %s: keys=%s",
                item.item_id, sorted(pending["input"].keys()) if isinstance(pending["input"], dict) else None)
    try:
        proposal = intake.build_proposal(
            item=item, submitted=pending["input"], stream_result=first, catalog=catalog,
        )
    except ValueError as exc:
        # Malformed proposal (e.g. missing `resolution`). Preserve the model's classification when it
        # supplied one — do NOT discard a correct class as unknown.
        logger.warning("harness malformed proposal for %s: %s", item.item_id, exc)
        submitted = pending["input"] if isinstance(pending["input"], dict) else {}
        cls_id, _ = intake.classify_submitted(
            submitted=submitted,
            catalog=catalog,
            tier1_hint=read_hint(attributes=item.attributes or {}),
        )
        _persist_degraded(
            cases=cases, item=item, steps=first.steps,
            reason=f"malformed proposal: {exc}", now=now, class_id=cls_id,
        )
        return "escalated"

    intake.persist(cases=cases, proposal=proposal)
    decision = intake.decide(proposal=proposal, threshold=threshold)

    outcome = "escalated"
    if decision["decision"] == "execute":
        # The WORKER executes the Policy-gated write through the egress gateway — the same
        # shared code path as the runtime backend. Cedar's confidence gate and the gateway
        # REQUEST interceptor's provenance check apply to this call like any other.
        from backend.recon_core.auto_resolve import autonomous_execute, maybe_auto_resolve
        from backend.recon_core.errors import ToolDenied
        from backend.recon_core.gateway_client import call_gateway_tool

        def _write(action: dict):
            args = {k: v for k, v in action.items() if k != "tool"}
            try:
                return call_gateway_tool(
                    "set-draw-status___set_draw_status", args, transport=write_transport
                )
            except RuntimeError as exc:
                # Preserve Policy-denial semantics so autonomous_execute escalates cleanly.
                if any(s in str(exc).lower() for s in ("denied", "accessdenied", "403")):
                    raise ToolDenied(str(exc)) from exc
                raise

        outcome = autonomous_execute(
            proposal=proposal, threshold=threshold, invoker=_write, now=now
        )
        intake.persist(cases=cases, proposal=proposal)  # re-persist to store the execute step
        if outcome == "executed":
            # APPROVED→RESOLVED + notification email + AUTO_RESOLVED lesson (shared path).
            maybe_auto_resolve(cases=cases, proposal=proposal, threshold=threshold)

    # Close the session: re-invoke with the decision + outcome as the toolResult so the agent
    # ends with an informational summary turn. Best-effort — the case state is already final.
    messages.append(_assistant_tooluse_message(pending))
    messages.append(_toolresult_message(pending["toolUseId"], {**decision, "outcome": outcome}))
    try:
        assemble_stream(invoke(messages))
    except Exception as exc:  # noqa: BLE001 - already persisted; summary failure changes nothing
        logger.warning("harness follow-up invoke failed for %s: %s", item.item_id, exc)

    logger.info("harness decision for %s: decision=%s outcome=%s confidence=%s",
                item.item_id, decision.get("decision"), outcome, decision.get("confidence"))
    return "executed" if outcome == "executed" else "escalated"


def handle(event, _context=None):  # pragma: no cover - live wiring; loop tested via run_investigation
    """Lambda entrypoint for the harness backend. Wires env + live InvokeHarness streaming.

    Expects ``{"item": {...}, "session_id": str}`` (agent_arn is ignored on this path).
    """
    import boto3

    from backend.recon_core.auto_resolve import get_threshold
    from backend.recon_core.skills_s3 import catalog_s3

    # Lambda's root logger defaults to WARNING, hiding our INFO submit/decision breadcrumbs.
    # Raise it so the submit_proposal keys + decision land in CloudWatch (they were invisible,
    # forcing diagnosis off the persisted case alone — observed 2026-07-27).
    logging.getLogger("backend").setLevel(os.environ.get("LOG_LEVEL", "INFO"))

    item = ReconItem.model_validate(event["item"])
    session_id = event["session_id"]
    harness_arn = os.environ["HARNESS_ARN"]
    region = os.environ.get("AWS_REGION", "us-east-1")
    bucket = os.environ.get("ASSETS_BUCKET", "")
    prefix = os.environ.get("SKILLS_PREFIX", "skills/")
    # The operator's live selection from the Config tab, with the deploy-time value as the fallback.
    # This is the BASE model: a deployed harness config version still overrides it below, which is
    # deliberate — that pin is how the Evals tab reproduces a scored configuration. The Config tab
    # says so, because otherwise switching models and watching the harness ignore it reads as the
    # control being broken.
    from backend.recon_core.model_select import get_agent_model_id

    model = get_agent_model_id(
        os.environ.get("AGENT_MODEL_PARAM", ""),
        default=os.environ.get("HARNESS_MODEL_ID", "us.anthropic.claude-sonnet-5"),
    )

    from backend.recon_core.prompt_source import CORE_PROMPT_KEY, HARNESS_CONTRACT_KEY, compose_prompt

    catalog = catalog_s3(bucket, prefix) if bucket else []
    # The policy half of the prompt is the SAME object the runtime backend reads — switching
    # backends must not change the agent's instructions. Only the calling contract below
    # (submit_proposal fields, prefixed tool names) is harness-specific.
    system = compose_prompt(
        core=_read_s3_text(bucket, os.environ.get("SYSTEM_PROMPT_KEY", CORE_PROMPT_KEY)),
        contract=_read_s3_text(bucket, os.environ.get("HARNESS_SYSTEM_PROMPT_KEY", HARNESS_CONTRACT_KEY)),
    )
    threshold = get_threshold(os.environ.get("AUTO_RESOLVE_PARAM", ""))

    # Worker-side lesson recall (advisory, fail-soft) — kept explicit + in-trace since the
    # harness memory is disabled.
    from backend.recon_core.lessons_recall import retrieve_lessons

    lessons = retrieve_lessons(
        memory_id=os.environ.get("MEMORY_ID", ""), domain=item.domain,
        query=f"{item.item_id} {item.attributes.get('idp_class') or ''} reconciliation break",
    )

    # Versioned config overrides (Evals tab Config-versions panel). When a config version is
    # deployed (SSM pointer set), its model_id/max_iterations override the blueprint defaults.
    # Its system_prompt is NOT applied here: deploying a version writes that text into the shared
    # core object above, so both backends pick it up (see backend/recon_core/prompt_source.py).
    # Absent pointer → use defaults (zero-config backward compatible).
    from backend.harness_agent.config_store import active_version, apply_overrides, load_config

    ssm_client = boto3.client("ssm", region_name=region)
    s3_client = boto3.client("s3", region_name=region)
    config_param = os.environ.get("HARNESS_CONFIG_VERSION_PARAM", "")
    invoke_kwargs: dict = {
        "model": {"bedrockModelConfig": {"modelId": model}},
        "systemPrompt": [{"text": system}] if system else [],
    }
    version = active_version(ssm=ssm_client, param_name=config_param)
    if version and bucket:
        cfg = load_config(s3=s3_client, bucket=bucket, version=version)
        if cfg:
            invoke_kwargs = apply_overrides(config=cfg, base_model=model, base_system_prompt=system)

    from backend.recon_core.otel_client import register_trace_propagation, traced

    client = boto3.client("bedrock-agentcore", region_name=region)
    # boto3 does NOT propagate trace context: without this hook the harness's spans land in their
    # own trace and can't be tied back to the invocation that caused them.
    register_trace_propagation(client)

    turn = 0

    def _invoke(messages):
        nonlocal turn
        turn += 1
        with traced("invoke_harness", attributes={"recon.item_id": item.item_id,
                                                  "recon.domain": item.domain,
                                                  "recon.turn": turn,
                                                  "gen_ai.harness.arn": harness_arn,
                                                  "session.id": session_id}):
            resp = client.invoke_harness(
                harnessArn=harness_arn,
                runtimeSessionId=session_id,
                messages=messages,
                **invoke_kwargs,
            )
            # Materialized (not lazily yielded) INSIDE the span so the span covers the whole
            # stream: its real duration and any mid-stream EventStreamError are recorded, rather
            # than the span closing after the first chunk arrives.
            return list(_iter_stream(resp))

    cases = CaseStore(table=os.environ["CASES_TABLE"], audit=os.environ["AUDIT_TABLE"])
    outcome = run_investigation(
        item=item, invoke=_invoke, cases=cases, catalog=catalog,
        threshold=threshold, lessons=lessons,
    )
    return {"outcome": outcome, "item_id": item.item_id}


def _iter_stream(resp):  # pragma: no cover - live stream shape verified in Task 9
    """Yield event dicts from an InvokeHarness streaming response (EventStream of chunks)."""
    stream = resp.get("stream") or resp.get("body") or []
    for event in stream:
        yield event


def _read_s3_text(bucket: str, key: str) -> str:  # pragma: no cover - thin S3 glue
    """Read a UTF-8 text object from S3 ('' on any failure — caller falls back)."""
    if not bucket:
        return ""
    try:
        import boto3

        obj = boto3.client("s3").get_object(Bucket=bucket, Key=key)
        return obj["Body"].read().decode("utf-8")
    except Exception:  # noqa: BLE001
        return ""

