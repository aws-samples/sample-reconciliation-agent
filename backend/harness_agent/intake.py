"""Turn the harness agent's ``submit_proposal`` output into a persisted, gated proposal.

The worker calls :func:`build_proposal` when the harness stops to run ``submit_proposal``:
  1. validate the model's structured output (pydantic-adjacent field checks);
  2. apply ``pick_class`` semantics against the SKILL.md catalog thresholds (below threshold →
     ``unknown``);
  3. DERIVE the ledger reference from the recorded ``search_ledger`` results (0 or >1 distinct
     refs ⇒ None ⇒ non-executable → forced escalate). The model NEVER picks the reference (F1);
  4. compute the composite confidence (IDP-weighted; grounding over item + tool outputs);
  5. build the Proposal + persist Decimal-safe via ``CaseStore.attach_proposal`` → PROPOSED.

:func:`decide` then returns the execute/escalate decision the worker feeds back to the agent as
the ``submit_proposal`` toolResult. The Cedar Policy on the gateway + the write Lambda's
provenance/threshold gates are the enforcement points; this decision is the app-level intent.
"""

from decimal import Decimal

from backend.recon_core.cases import CaseStore
import logging

from backend.recon_core.confidence import composite_confidence_idp, grounding_fraction
from backend.recon_core.email_policy import build_persisted_draft, coerce_email_draft
from backend.recon_core.schema import Proposal, ReasoningStep


def _as_result_dict(result: object) -> dict | None:
    """Coerce one recorded ``search_ledger`` result into a dict, tolerant of the LIVE shape.

    The live AgentCore gateway returns MCP tool results as ``text`` content parts — a
    stringified-JSON blob — so ``stream._extract_payload`` yields a ``str`` and
    ``tool_outputs["search_ledger"]`` holds JSON *strings*, not dicts (unit-test fixtures use
    structured ``{"json": {...}}`` parts, which is why this went unnoticed). A raw ``str`` here
    silently produced zero references → ``proposed_action=None`` → every clean single-match case
    escalated instead of auto-resolving, regardless of confidence. Parse the string; anything
    that is neither a dict nor JSON-decodable to one is skipped.

    :param result: one element of ``tool_outputs["search_ledger"]`` (dict | JSON str | other).
    :returns: the result as a dict, or None when it is not / does not decode to one.
    """
    import json

    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            decoded = json.loads(result)
        except (json.JSONDecodeError, ValueError):
            return None
        return decoded if isinstance(decoded, dict) else None
    return None


def derive_reference(tool_outputs: dict) -> str | None:
    """The single ledger reference the agent's search_ledger calls matched, or None if 0/>1.

    Thin shape-adapter over the SHARED rule in ``recon_core.proposal_service`` (one
    implementation for both backends): collect every reference across the recorded
    ``search_ledger`` results, then exactly-one-distinct wins. Results may be dicts (fixtures)
    or JSON strings (live gateway text parts) — see :func:`_as_result_dict`.

    :param tool_outputs: StreamResult.tool_outputs (short tool name → list of results).
    :returns: the sole matched reference, or None.
    """
    from backend.recon_core.proposal_service import derive_reference as _derive

    refs: list[str] = []
    for result in tool_outputs.get("search_ledger", []) or []:
        parsed = _as_result_dict(result)
        rows = parsed.get("rows", []) if parsed is not None else []
        for row in rows:
            ref = row.get("reference") if isinstance(row, dict) else None
            if ref:
                refs.append(str(ref))
    return _derive(refs)


def _coerce_evidence(raw) -> list[str]:
    """Normalize the model's ``evidence`` field into a clean ``list[str]``.

    The harness does not enforce the inline-function argument schema, so ``evidence`` arrives in
    whatever shape the model emitted. Observed live: a JSON-encoded STRING (e.g.
    ``'["issuer: X", "facility: Y"]'``) instead of an array. The previous ``list(raw or [])``
    silently exploded such a string into one element PER CHARACTER — corrupting both the grounding
    denominator and the UI (one bordered box per letter). This coerces defensively:

      * ``None``/empty            -> ``[]``;
      * a ``list``               -> each element stringified (drop empties);
      * a ``str`` that parses as a JSON array -> that array, stringified;
      * any other ``str``        -> a single-element list (the whole string is one evidence item,
                                     NEVER split into characters);
      * anything else            -> a single stringified element.

    :param raw: the ``submit_proposal`` ``evidence`` field, any shape.
    :returns: a list of non-empty evidence strings.
    """
    import json

    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        return [str(e) for e in raw if e not in (None, "")]
    if isinstance(raw, str):
        stripped = raw.strip()
        # A JSON-array string is the observed corruption — decode it back to a real list.
        if stripped.startswith("[") and stripped.endswith("]"):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    return [str(e) for e in parsed if e not in (None, "")]
            except json.JSONDecodeError:
                pass
        # A plain (non-JSON) string is ONE evidence item — do not iterate its characters.
        return [stripped]
    return [str(raw)]


def _classify(*, submitted: dict, catalog: list[dict]) -> tuple[str, float, str]:
    """Apply pick_class threshold semantics to the submitted classification.

    :returns: (class_id, class_confidence, reasoning) — class_id is 'unknown' when the model's
        confidence is below the global DEFAULT_CLASS_THRESHOLD (reasoning preserved).
    """
    from backend.recon_core.skills_s3 import DEFAULT_CLASS_THRESHOLD

    name = str(submitted.get("class_name") or "unknown")
    conf = float(submitted.get("classification_confidence") or 0.0)
    reasoning = str(submitted.get("classification_reasoning") or "")
    known = {c["name"] for c in catalog}
    if name in known and conf >= DEFAULT_CLASS_THRESHOLD:
        return name, conf, reasoning
    return "unknown", conf, reasoning


def classify_submitted(*, submitted: dict, catalog: list[dict]) -> tuple[str, float, str]:
    """Public wrapper over :func:`_classify` for the degraded-persist path.

    When a proposal is otherwise malformed (e.g. missing ``resolution``) the worker still wants to
    preserve the model's chosen classification + its confidence rather than collapse the case to
    ``unknown``/0. This exposes the same pick_class semantics without duplicating them.

    :param submitted: the raw ``submit_proposal`` input the agent emitted.
    :param catalog: the SKILL.md catalog (for classification thresholds).
    :returns: (class_id, class_confidence, reasoning) — see :func:`_classify`.
    """
    return _classify(submitted=submitted, catalog=catalog)


def build_proposal(
    *,
    item,
    submitted: dict,
    stream_result,
    catalog: list[dict],
    idp_classification_confidence: float | None,
    idp_alerts: int = 0,
) -> Proposal:
    """Validate + assemble the Proposal from submit_proposal input and the recorded stream.

    :param item: the ReconItem under investigation.
    :param submitted: the ``submit_proposal`` tool input the agent emitted.
    :param stream_result: the StreamResult (steps trace + tool_outputs for reference derivation).
    :param catalog: the SKILL.md catalog (for classification thresholds).
    :param idp_classification_confidence: IDP's class confidence in [0,1], or None.
    :param idp_alerts: count of low-confidence IDP fields (>0 shaves the composite).
    :returns: the assembled Proposal (not yet persisted).
    :raises ValueError: when required submit_proposal fields are missing.
    """
    original_keys_pre = sorted(submitted.keys()) if isinstance(submitted, dict) else None
    # Deterministic alias normalization (logged, then still strictly validated): models
    # sometimes follow prose names instead of the schema. Explicit map only — no guessing.
    _ALIASES = {"classification": "class_name", "confidence": "verbalized_confidence",
                "reasoning": "classification_reasoning",
                # `resolution` is required but the harness does not enforce it; the model
                # frequently supplies only `reason` (the ledger-overlay note) and drops the
                # top-level narrative (observed live 2026-07-27: submit dropped `resolution`,
                # nuking a clean single-match case to unknown/confidence-0). When `resolution`
                # is absent but `reason` is present, reuse `reason` as the resolution narrative
                # rather than hard-failing — `reason` still remains for the proposed_action.
                "reason": "resolution"}
    # When class_name is already present, a stray `classification` field is the reasoning text
    # (observed live: the model sent both). The harness does not enforce the schema's required
    # list on inline functions, so normalization here is the practical contract enforcement.
    if submitted.get("class_name") not in (None, "") and submitted.get("classification") not in (None, ""):
        _ALIASES = {**_ALIASES, "classification": "classification_reasoning"}
    for alias, canonical in _ALIASES.items():
        if submitted.get(canonical) in (None, "") and submitted.get(alias) not in (None, ""):
            logging.getLogger(__name__).warning(
                "submit_proposal: normalizing alias field %r -> %r", alias, canonical)
            submitted[canonical] = submitted[alias]

    original_keys = original_keys_pre
    # classification_reasoning is display metadata, not a gate — models frequently omit it.
    if submitted.get("classification_reasoning") in (None, ""):
        submitted["classification_reasoning"] = "(model did not provide classification_reasoning)"
    for required in ("class_name", "resolution", "verbalized_confidence"):
        if submitted.get(required) in (None, ""):
            raise ValueError(
                f"submit_proposal missing required field {required!r} "
                f"(original submitted keys: {original_keys})"
            )

    class_id, class_conf, class_reason = _classify(submitted=submitted, catalog=catalog)
    verbalized = float(submitted.get("verbalized_confidence") or 0.0)

    # Derive the executable action: only when there's a single clean ledger ref AND a status.
    reference = derive_reference(stream_result.tool_outputs)
    status = submitted.get("status")
    proposed_action = None
    if reference and status:
        proposed_action = {
            "tool": "set_draw_status",
            "reference": reference,
            "status": status,
            "reason": str(submitted.get("reason") or ""),
            "item_id": item.item_id,
        }

    # The counterparty email draft, built through the same helper the runtime backend uses so both
    # persist an identical shape — a divergence would surface only much later, as an interceptor
    # denial at send time, on whichever backend happened to run. The helper drops any address the
    # model supplied. An incomplete draft is dropped with a warning rather than raised: the harness
    # HITL loop cannot recover from a raise here, and the item still escalates with its resolution.
    proposed_email = None
    submitted_draft = submitted.get("email_draft")
    # Coerced first: the harness does not enforce the argument schema, and the model was observed
    # emitting this nested object as a JSON STRING — see `coerce_email_draft`.
    email_draft = coerce_email_draft(submitted_draft)
    if email_draft:
        try:
            proposed_email = build_persisted_draft(email_draft=email_draft)
        except ValueError as exc:
            logging.getLogger(__name__).warning(
                "submit_proposal: discarding incomplete `email_draft` — %s", exc)
    elif submitted_draft:
        # Log the value, truncated: the type name alone cannot distinguish a model writing prose
        # where an object belongs from a JSON object string that failed to parse.
        logging.getLogger(__name__).warning(
            "submit_proposal: ignoring `email_draft` of type %s (expected an object): %.200r",
            type(submitted_draft).__name__,
            submitted_draft,
        )

    # Grounding haystack = item JSON + recorded tool outputs; needles = submitted evidence.
    import json

    haystack = json.dumps(item.model_dump(), default=str) + json.dumps(
        stream_result.tool_outputs, default=str
    )
    # Coerce ONCE — the model's evidence may be a JSON-string; reuse for grounding + the trace.
    evidence = _coerce_evidence(submitted.get("evidence"))
    grounding = grounding_fraction(evidence=evidence, haystack=haystack)

    composite = composite_confidence_idp(
        idp_confidence=idp_classification_confidence,
        grounding=grounding,
        verbalized=verbalized,
        idp_alerts=idp_alerts,
    )

    # The trace = the tool-call steps assembled from the stream + a final propose step.
    steps: list[ReasoningStep] = list(stream_result.steps)
    steps.append(
        ReasoningStep(
            skill=class_id, confidence=verbalized, kind="propose",
            reasoning=str(submitted.get("resolution")),
            evidence=evidence,
        )
    )

    # classification_confidence surfaced to the UI. Consistency with the RUNTIME backend, which
    # always surfaces the MODEL's classification confidence (``classifier.pick_class`` preserves it
    # even on the unknown fallback). IDP's class confidence already feeds the COMPOSITE via
    # ``composite_confidence_idp`` — it must NOT also masquerade as the displayed classification
    # confidence. Prefer the model's own value; fall back to IDP's, then to the overall verbalized
    # confidence, so a real proposal never surfaces a bare 0 — the "Unclassified/0" observed when
    # the model omitted ``classification_confidence`` AND there was no IDP class confidence
    # (2026-07-27, idp-Borrowing_Notice on the harness backend).
    if class_conf > 0:
        class_confidence_shown = class_conf
    elif idp_classification_confidence is not None:
        class_confidence_shown = idp_classification_confidence
    else:
        class_confidence_shown = verbalized
    return Proposal(
        item_id=item.item_id,
        class_id=class_id,
        classification_confidence=class_confidence_shown,
        classification_reasoning=class_reason,
        resolution=str(submitted.get("resolution")),
        confidence=composite,
        confidence_components={
            "idp": idp_classification_confidence,
            "grounding": grounding,
            "verbalized": verbalized,
            "idp_alerts": idp_alerts,
        },
        steps=steps,
        proposed_action=proposed_action,
        proposed_email=proposed_email,
    )


def persist(*, cases: CaseStore, proposal: Proposal) -> None:
    """Attach the proposal to the case (Decimal-safe) and advance IN_PROGRESS → PROPOSED."""
    from backend.recon_core.status import CaseStatus

    steps = [
        {
            "skill": s.skill,
            "confidence": Decimal(str(s.confidence)),
            "reasoning": s.reasoning,
            "evidence": s.evidence,
            "ts": s.ts,
            **{
                k: v
                for k, v in {
                    "kind": s.kind, "tool": s.tool, "tool_input": s.tool_input,
                    "tool_output": s.tool_output, "action": s.action, "outcome": s.outcome,
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
    cases.transition("item_id", proposal.item_id, CaseStatus.PROPOSED)


def decide(*, proposal: Proposal, threshold: float | None) -> dict:
    """The execute/escalate decision fed back to the agent as the submit_proposal toolResult.

    Execute only when the composite clears the threshold AND there is a clean executable action;
    otherwise escalate for human review.

    :returns: ``{decision, reference, composite, threshold}`` (decision ∈ execute|escalate).
    """
    executable = proposal.proposed_action is not None
    clears = threshold is not None and proposal.confidence >= threshold
    decision = "execute" if (executable and clears) else "escalate"
    return {
        "decision": decision,
        "reference": (proposal.proposed_action or {}).get("reference"),
        "composite": round(float(proposal.confidence), 4),
        "threshold": threshold,
    }
