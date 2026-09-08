"""Turn the harness agent's ``submit_proposal`` output into a persisted, gated proposal.

The worker calls :func:`build_proposal` when the harness stops to run ``submit_proposal``:
  1. validate the model's structured output (pydantic-adjacent field checks);
  2. apply ``pick_class`` semantics against the SKILL.md catalog (a name that is not IN the catalog →
     ``unknown``; there is no confidence floor);
  3. DERIVE the ledger reference from the recorded ``search_ledger`` results (0 or >1 distinct
     refs ⇒ None ⇒ non-executable → forced escalate). The model NEVER picks the reference (F1);
  4. score the proposal's EVIDENCE COMPLETENESS against the classified skill's prescribed steps
     (``score_proposal``, shared with the runtime backend), after downgrading any satisfied-claim no
     recorded tool call supports;
  5. build the Proposal + persist Decimal-safe via ``CaseStore.attach_proposal`` → PROPOSED.

:func:`decide` then returns the execute/escalate decision the worker feeds back to the agent as
the ``submit_proposal`` toolResult. The Cedar Policy on the gateway + the write Lambda's
provenance/threshold gates are the enforcement points; this decision is the app-level intent.
"""

from decimal import Decimal

from backend.recon_core.cases import CaseStore
import logging
import os

from backend.recon_core.confidence import (
    coerce_step_reports,
    downgrade_unsupported_reports,
    score_proposal,
)
from backend.recon_core.email_policy import build_persisted_draft, coerce_email_draft
from backend.recon_core.proposal_service import judge_cited_evidence
from backend.recon_core.schema import Proposal, ReasoningStep
from backend.recon_core.tier1_hint import read_hint, warn_on_disagreement


def _rows_from(tool_outputs: dict, tool: str, *, key: str = "rows") -> list[dict]:
    """Flatten every result of one tool into the list of records it returned.

    Two shapes, one adapter: ``search_notices`` packs its records under ``rows`` and a guidance retrieval
    packs them under ``retrievalResults``. Both arrive either as dicts or as JSON strings depending on
    whether the call went through the live gateway, which is what :func:`_as_result_dict` normalises.

    :param tool_outputs: StreamResult.tool_outputs (short tool name -> list of results).
    :param tool: the short tool name.
    :param key: the key the tool packs its records under.
    :returns: every record, across every call to that tool.
    """
    records: list[dict] = []
    for result in tool_outputs.get(tool, []) or []:
        parsed = _as_result_dict(result)
        if parsed is None:
            continue
        for record in parsed.get(key, []) or []:
            if isinstance(record, dict):
                records.append(record)
    return records


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


def derive_notice_id(tool_outputs: dict) -> str | None:
    """The single notice the agent's search_notices calls matched, or None if 0/>1.

    Same shape-adapter pattern and the same shared exactly-one-distinct rule as
    :func:`derive_reference`, over ``notice_id`` instead of ``reference``. The value is DERIVED from
    what the tool returned, never taken from the model's submission: the gateway interceptor refuses
    a ledger write unless the cited notice's extraction is clean, so a
    model-supplied id would let a proposal nominate a clean notice while reasoning from a doubtful
    one — the guard would still pass and still be checking the wrong document.

    :param tool_outputs: StreamResult.tool_outputs (short tool name → list of results).
    :returns: the sole matched notice_id, or None.
    """
    from backend.recon_core.proposal_service import derive_reference as _derive

    ids: list[str] = []
    for result in tool_outputs.get("search_notices", []) or []:
        parsed = _as_result_dict(result)
        rows = parsed.get("rows", []) if parsed is not None else []
        for row in rows:
            notice_id = row.get("notice_id") if isinstance(row, dict) else None
            if notice_id:
                ids.append(str(notice_id))
    return _derive(ids)


def _coerce_evidence(raw) -> list[str]:
    """Normalize the model's ``evidence`` field into a clean ``list[str]``.

    The harness does not enforce the inline-function argument schema, so ``evidence`` arrives in
    whatever shape the model emitted. Observed live: a JSON-encoded STRING (e.g.
    ``'["issuer: X", "facility: Y"]'``) instead of an array. A plain ``list(raw or [])`` explodes
    such a string into one element PER CHARACTER, which renders in the UI as one bordered box per
    letter. This coerces defensively:

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


def _classify(
    *, submitted: dict, catalog: list[dict], tier1_hint: str | None = None
) -> tuple[str, str]:
    """Apply pick_class semantics to the submitted classification.

    Deliberately identical to ``agent-blueprint/recon-agent/classifier.pick_class``: the same item
    must classify the same way on both Tier-2 backends, so any rule added here has to be added there
    too. That is the invariant ``tests/recon_core/test_confidence_idp.py`` checks by scoring one item
    on both backends.

    Membership in the catalog is the ONLY test. There is no confidence floor — see the note in
    ``classifier.py`` for why the 0.6 one was net-harmful.

    :param submitted: the raw ``submit_proposal`` input the agent emitted.
    :param catalog: the SKILL.md catalog — the set of known classification names.
    :param tier1_hint: Tier-1's rule-table guess (``recon_core.tier1_hint.read_hint``), or None.
        **Advisory and never overruling** — compared to the result only so a disagreement is logged,
        exactly as on the runtime backend.
    :returns: (class_id, reasoning) — class_id is 'unknown' when the model named no catalog entry.
    """
    name = str(submitted.get("class_name") or "unknown")
    reasoning = str(submitted.get("classification_reasoning") or "")
    known = {c["name"] for c in catalog}
    class_id = name if name in known else "unknown"
    warn_on_disagreement(class_id=class_id, tier1_hint=tier1_hint)
    return class_id, reasoning


def classify_submitted(
    *, submitted: dict, catalog: list[dict], tier1_hint: str | None = None
) -> tuple[str, str]:
    """Public wrapper over :func:`_classify` for the degraded-persist path.

    When a proposal is otherwise malformed (e.g. missing ``resolution``) the worker still wants to
    preserve the model's chosen classification rather than collapse the case to ``unknown``. This
    exposes the same pick_class semantics without duplicating them.

    :param submitted: the raw ``submit_proposal`` input the agent emitted.
    :param catalog: the SKILL.md catalog — the set of known classification names.
    :param tier1_hint: passed straight through to :func:`_classify`; advisory only.
    :returns: (class_id, reasoning) — see :func:`_classify`.
    """
    return _classify(submitted=submitted, catalog=catalog, tier1_hint=tier1_hint)


def build_proposal(
    *,
    item,
    submitted: dict,
    stream_result,
    catalog: list[dict],
) -> Proposal:
    """Validate + assemble the Proposal from submit_proposal input and the recorded stream.

    :param item: the ReconItem under investigation.
    :param submitted: the ``submit_proposal`` tool input the agent emitted.
    :param stream_result: the StreamResult (steps trace + tool_outputs for reference derivation).
    :param catalog: the SKILL.md catalog — the set of known classification names AND the prescribed
        evidence steps the proposal's confidence is scored against. No classification threshold is
        read from it: catalog membership is the whole classification test.
    :returns: the assembled Proposal (not yet persisted).
    :raises ValueError: when required submit_proposal fields are missing, or the classified skill is
        absent from ``catalog`` / declares a malformed evidence-step list.
    """
    original_keys_pre = sorted(submitted.keys()) if isinstance(submitted, dict) else None
    # Deterministic alias normalization (logged, then still strictly validated): models
    # sometimes follow prose names instead of the schema. Explicit map only — no guessing.
    _ALIASES = {
        "classification": "class_name",
        "reasoning": "classification_reasoning",
        # `resolution` is required but the harness does not enforce it; the model
        # frequently supplies only `reason` (the ledger-overlay note) and drops the
        # top-level narrative (observed live 2026-07-27: submit dropped `resolution`,
        # nuking a clean single-match case to unknown/confidence-0). When `resolution`
        # is absent but `reason` is present, reuse `reason` as the resolution narrative
        # rather than hard-failing — `reason` still remains for the proposed_action.
        "reason": "resolution",
    }
    # When class_name is already present, a stray `classification` field is the reasoning text
    # (observed live: the model sent both). The harness does not enforce the schema's required
    # list on inline functions, so normalization here is the practical contract enforcement.
    if submitted.get("class_name") not in (None, "") and submitted.get("classification") not in (
        None,
        "",
    ):
        _ALIASES = {**_ALIASES, "classification": "classification_reasoning"}
    for alias, canonical in _ALIASES.items():
        if submitted.get(canonical) in (None, "") and submitted.get(alias) not in (None, ""):
            logging.getLogger(__name__).warning(
                "submit_proposal: normalizing alias field %r -> %r", alias, canonical
            )
            submitted[canonical] = submitted[alias]

    original_keys = original_keys_pre
    # classification_reasoning is display metadata, not a gate — models frequently omit it.
    if submitted.get("classification_reasoning") in (None, ""):
        submitted["classification_reasoning"] = "(model did not provide classification_reasoning)"
    for required in ("class_name", "resolution"):
        if submitted.get(required) in (None, ""):
            raise ValueError(
                f"submit_proposal missing required field {required!r} "
                f"(original submitted keys: {original_keys})"
            )

    class_id, class_reason = _classify(
        submitted=submitted,
        catalog=catalog,
        # `item.attributes` directly, not `getattr(...)`: the only caller passes a ReconItem
        # (worker.py) and so does every test, so a missing attribute is a wiring bug that must
        # raise here rather than be papered over as "no Tier-1 hint". Matches worker.py:142 and
        # agent.py:161/306.
        tier1_hint=read_hint(attributes=item.attributes or {}),
    )

    # Derive the executable action: only when there's a single clean ledger ref AND a status.
    reference = derive_reference(stream_result.tool_outputs)
    notice_id = derive_notice_id(stream_result.tool_outputs)
    verdict, verdict_reason = judge_cited_evidence(
        notice_rows=_rows_from(stream_result.tool_outputs, "search_notices"),
        guidance_results=_rows_from(
            stream_result.tool_outputs, "search_guidance", key="retrievalResults"
        ),
        workflow_types_table=os.environ.get("WORKFLOW_TYPES_TABLE", ""),
    )
    status = submitted.get("status")
    proposed_action = None
    if reference and status:
        proposed_action = {
            "tool": "set_draw_status",
            "reference": reference,
            "status": status,
            "reason": str(submitted.get("reason") or ""),
            "item_id": item.item_id,
            # The notice this proposal rests on, or None when the investigation matched no notice
            # (or matched several ambiguously). The interceptor reads this to decide whether the
            # extraction behind the write is trustworthy. Written even when
            # None so the key is always present: "cited nothing" and "cited something
            # unresolvable" are different decisions there, and an absent key collapses them.
            "notice_id": notice_id,
            # Whether the cited evidence is good enough to write from, decided HERE rather than at the
            # gateway. The gateway used to look up the cited notice and read its extraction alert count,
            # which only worked while extraction was the one way a document arrived; a proposal grounded
            # on retrieved correspondence cited no notice and passed the guard ungated. Written
            # unconditionally, like notice_id and for the same reason — at the gateway an ABSENT verdict
            # is a refusal, so the key must always be present for a present verdict to mean anything.
            #
            # Derived from the tool outputs, never from the model's submission: a model that could set
            # its own verdict would hold the gate's own key.
            "evidence_quality": verdict,
            "evidence_quality_reason": verdict_reason,
        }

    # The counterparty email draft, built through the same helper the runtime backend uses so both
    # persist an identical shape — a divergence would surface only much later, as an interceptor
    # denial at send time, on whichever backend happened to run. The helper renders the operator's
    # template and refuses a draft citing no contact or no template, or carrying a literal address.
    # That refusal is dropped with a warning rather than raised: the harness HITL loop cannot recover
    # from a raise here, and the item still escalates with its resolution. A template that fails to
    # RENDER is not a refusal — it comes back marked render_failed so the operator sees what to fix.
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
                "submit_proposal: discarding incomplete `email_draft` — %s", exc
            )
    elif submitted_draft:
        # Log the value, truncated: the type name alone cannot distinguish a model writing prose
        # where an object belongs from a JSON object string that failed to parse.
        logging.getLogger(__name__).warning(
            "submit_proposal: ignoring `email_draft` of type %s (expected an object): %.200r",
            type(submitted_draft).__name__,
            submitted_draft,
        )

    # Coerced here rather than at the use site: the model's evidence may arrive as a JSON-string, and
    # the propose step below is not the only thing that reads it.
    evidence = _coerce_evidence(submitted.get("evidence"))

    # The trace = the tool-call steps assembled from the stream, then the agent's per-step evidence
    # reports (before the propose step, so the case timeline reads in the order the work happened),
    # then the final propose step.
    steps: list[ReasoningStep] = list(stream_result.steps)
    steps.extend(coerce_step_reports(raw=submitted.get("evidence_steps"), skill=class_id))
    steps = downgrade_unsupported_reports(
        steps=steps,
        # The tools whose call came back with a result recorded. `stream.py` appends a payload per
        # toolResult block unconditionally (even a `None` payload), so the empty-list check only
        # excludes a key created without any result at all — meaning this is "a tool call ran and
        # came back", not "a tool call yielded rows". Same reading as the runtime's
        # `agent.observed_tools_from`, which is the point: the identical trace must score identically
        # on both backends. See that docstring for what the coarse check does and does not catch.
        observed_tools={t for t, results in stream_result.tool_outputs.items() if results},
    )
    steps.append(
        ReasoningStep(
            skill=class_id,
            kind="propose",
            reasoning=str(submitted.get("resolution")),
            evidence=evidence,
        )
    )

    # The score the auto-resolve threshold compares against: the fraction of the classified skill's
    # REQUIRED prescribed steps that obtained data. Shared with the runtime backend so the same trace
    # cannot score differently depending on which backend ran the item.
    computed, components = score_proposal(skills=catalog, class_id=class_id, steps=steps)

    return Proposal(
        item_id=item.item_id,
        class_id=class_id,
        classification_reasoning=class_reason,
        resolution=str(submitted.get("resolution")),
        confidence=computed,
        # Only the evidence-completeness breakdown. Nothing the model says about itself is stored
        # anywhere on the proposal now, but this comment is about the components specifically: keeping
        # extra diagnostic terms beside the computed score meant three numbers sat side by side and the
        # two diagnostics read as scores. Grounding in particular measured whether the agent's prose
        # evidence strings appeared verbatim in the item JSON, which they never do, so it displayed a
        # permanent 0.00 next to a case that had satisfied every prescribed step.
        confidence_components=components,
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
            "reasoning": s.reasoning,
            "evidence": s.evidence,
            "ts": s.ts,
            **{
                k: v
                for k, v in {
                    "kind": s.kind,
                    # Written by nobody; present only on traces persisted before 2026-09-04. It sits
                    # in this block precisely because it is None now — `Decimal(str(None))` raises.
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
    )
    cases.transition("item_id", proposal.item_id, CaseStatus.PROPOSED)


def decide(*, proposal: Proposal, threshold: float | None) -> dict:
    """The execute/escalate decision fed back to the agent as the submit_proposal toolResult.

    Execute only when the evidence-completeness score clears the threshold AND there is a clean
    executable action;
    otherwise escalate for human review.

    :returns: ``{decision, reference, confidence, threshold}`` (decision ∈ execute|escalate). The key
        is ``confidence`` because the value is a single evidence-completeness fraction and not a blend
        of several terms; the model reads this dict back as its toolResult, so the name is part of the
        contract.
    """
    executable = proposal.proposed_action is not None
    clears = threshold is not None and proposal.confidence >= threshold
    decision = "execute" if (executable and clears) else "escalate"
    return {
        "decision": decision,
        "reference": (proposal.proposed_action or {}).get("reference"),
        "confidence": round(float(proposal.confidence), 4),
        "threshold": threshold,
    }
