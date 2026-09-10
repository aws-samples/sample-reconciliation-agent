"""Computed confidence for agent proposals: evidence completeness.

The value that drives auto-resolution is

    confidence = satisfied_required_steps / prescribed_required_steps

— the fraction of the classified skill's REQUIRED declared evidence steps whose tool call actually
returned data answering it. A 4-step skill that obtained 3 scores 0.75.

Deliberately NOT a weighted composite of classification confidence, evidence grounding and the
model's verbalized number. Two of those three are the model's assessment of itself, and the third is
computed from evidence the model chose to cite — so a confident, well-cited, wrong proposal scores
high. Evidence completeness instead asks a question with a checkable answer: did the investigation
obtain the data its own skill prescribed?

**What this score does NOT measure.** Coverage is not accuracy. A proposal can satisfy every
prescribed step and still match the wrong record, scoring 1.0. Whether answers are *right* is
measured only by the labelled eval set and the Online Evaluation configuration. Nothing in this
module should ever be read as a correctness signal.

**Backend-agnostic by construction.** Both agent backends call :func:`score_proposal` with the same
trace, so their scores are identical rather than merely reconciled — the property
``tests/recon_core/test_confidence_idp.py`` asserts. The arithmetic deliberately lives here and never
in a prompt, which is what makes that identity possible.

**Threshold interaction.** The score is a rational fraction, so a 4-step skill can only produce 0.00,
0.25, 0.50, 0.75 or 1.00. With the auto-resolve threshold at 0.85, no skill with fewer than seven
required steps can auto-resolve below full evidence (6/7 ≈ 0.857 is the first sub-perfect value that
clears). That is the intended posture — full evidence for straight-through processing — and it is
arithmetic rather than a coded control, so it is stated here rather than left to be rediscovered.

**One number, not three.** Two tempting companions are deliberately absent, and neither should be
added back as a "displayed diagnostic": the model's own verbalized confidence, and a grounding
fraction measuring how much of the agent's cited evidence appears verbatim in the item data. The
self-report is not evidence about the investigation. Grounding measures almost nothing, because the
agent cites evidence as prose ("bank side amount=26772.73, entry_type=CREDIT") that never appears
literally in the item JSON — it reads as a permanent 0.00 beside cases that satisfied every prescribed
step. Three numbers side by side, two of which are not scores, is a worse answer than one that is.
"""

import json

from backend.recon_core.schema import EvidenceStep, ReasoningStep
from backend.recon_core.skill_meta import step_field


def evidence_completeness(
    *, prescribed: list[EvidenceStep | dict], steps: list[ReasoningStep]
) -> tuple[float, dict]:
    """Fraction of the skill's REQUIRED prescribed steps that obtained data.

    This is the score that drives auto-resolution. It replaces a weighted composite two
    of whose terms were things the model said about itself; this one is checkable against the trace.

    Only required steps are counted. A step reported ``satisfied=False`` and a step never reported at
    all both count as unsatisfied, but they are listed separately in the returned components because
    "the agent never looked" and "the agent looked and the data is not there" are different findings
    for the human reading the case.

    The arithmetic lives here rather than in the prompt so both agent backends produce bit-identical
    scores for identical traces — the invariant ``tests/recon_core/test_confidence_idp.py`` asserts.

    An id the skill never declared is IGNORED for scoring and reported in ``undeclared_step_ids``
    rather than raised on. It is a model reporting error, not a declaration error: the skill file is
    fine, the model just named a step nobody asked for. Raising would discard the whole investigation:
    a runtime reporting ``account_name_match`` (a name the skill's PROSE invites while its front
    matter declares ``expected_entry_match``) would throw away minutes of work and several hundred
    tool calls, leaving the case stuck in IN_PROGRESS with no proposal and no analyst-visible reason.
    Ignoring cannot inflate the score, because an undeclared id is by
    definition not one of ``required_ids`` — the worst it can do is leave a required step
    unattempted, which lowers the score and is listed for the human. Same call, for the same reason,
    as :func:`downgrade_unsupported_reports` makes for unsupported satisfied-claims.

    :param prescribed: the loaded skill's ``evidence_steps`` entries, as ``EvidenceStep`` models OR
        as the JSON dicts :func:`skill_meta.catalog_entry` projects them to. BOTH shapes must be
        accepted, which is why the fields are read through ``skill_meta.step_field``: the runtime
        backend loads real skills and gets models, while the harness backend has no skill-loading
        tool and can only pass the catalog. Reading ``s.required`` directly would make every harness
        proposal die with ``AttributeError: 'dict' object has no attribute 'required'`` — but only
        once its classification works, since ``unknown`` declares no steps and returns first.
    :param steps: the agent's reasoning trace for this proposal.
    :returns: ``(score, components)``; components carries ``prescribed``, ``satisfied``,
        ``unsatisfied_step_ids``, ``unattempted_step_ids`` and ``undeclared_step_ids`` for the audit
        trail.
    :raises ValueError: when ``prescribed`` declares no required step — a zero denominator is a
        declaration bug, not a score, and the fix is to edit the skill file.
    """
    required_ids = [step_field(s, "id") for s in prescribed if step_field(s, "required")]
    if not required_ids:
        raise ValueError(
            f"skill declares no required evidence steps "
            f"(ids={[step_field(s, 'id') for s in prescribed]}) — "
            "evidence completeness has no denominator"
        )
    declared = {step_field(s, "id") for s in prescribed}

    # Last report wins: a retried tool call reports the same step twice and the final outcome is the
    # investigation's conclusion.
    outcomes: dict[str, bool | None] = {}
    undeclared: list[str] = []
    for step in steps:
        if step.step_id is None:
            continue  # trace entries that are not evidence steps (skill_load, propose, execute)
        if step.step_id not in declared:
            # Recorded, not raised (see the docstring). Kept in report order and de-duplicated so a
            # retried call does not list the same invented id twice.
            if step.step_id not in undeclared:
                undeclared.append(step.step_id)
            continue
        outcomes[step.step_id] = step.satisfied

    satisfied = [i for i in required_ids if outcomes.get(i) is True]
    unsatisfied = [i for i in required_ids if outcomes.get(i) is False]
    # `is None` covers BOTH no report at all and a report whose outcome is None — an uninterpretable
    # `satisfied` from `coerce_step_reports`, or a satisfied-claim `downgrade_unsupported_reports`
    # rewrote. All three mean "no data was obtained and the agent did not say it tried and failed".
    # Keying on `i not in outcomes` instead would score those steps at 0 while listing them in
    # neither bucket, leaving the human a checklist that silently omits a step.
    unattempted = [i for i in required_ids if outcomes.get(i) is None]
    return len(satisfied) / len(required_ids), {
        "prescribed": len(required_ids),
        "satisfied": len(satisfied),
        "unsatisfied_step_ids": unsatisfied,
        "unattempted_step_ids": unattempted,
        # Always present, empty in the normal case: an absent key would render as "no problem" in the
        # UI whether the check ran or not, and this is the one component that reports a defect in the
        # AGENT's reporting rather than in the evidence.
        "undeclared_step_ids": undeclared,
    }


def score_proposal(
    *, skills: list[dict], class_id: str, steps: list[ReasoningStep]
) -> tuple[float, dict]:
    """Score a proposal's evidence completeness against the skill it was classified under.

    The single entry point both agent backends call, so the two cannot drift: the runtime container
    and the harness worker resolve the same skill and run the same arithmetic on the same trace.

    A skill that declares no ``evidence_steps`` at all is **unscoreable**, not an error: ``unknown``
    is the classification fallback and is not a break-type skill, so nothing was prescribed and
    nothing can be evidenced. It scores 0.0 and escalates. A skill that declares steps but marks
    none required is a different thing — a break-type declaration bug — and raises through
    :func:`evidence_completeness`.

    :param skills: the skills available to this investigation — ``parse_skill`` records from the
        runtime backend, or :func:`skill_meta.catalog_entry` projections from the harness backend,
        which has no skill-loading tool. Both are accepted; see :func:`evidence_completeness`.
    :param class_id: the classified break type, which is also the driving skill's ``name``.
    :param steps: the agent's reasoning trace.
    :returns: ``(score, components)``; components always carries ``skill``, plus either the
        completeness breakdown or an ``unscoreable`` explanation.
    :raises ValueError: when ``class_id`` names no loaded skill, or the resolved skill's declaration
        is malformed.
    """
    matched = [s for s in skills if s.get("name") == class_id]
    if not matched:
        raise ValueError(
            f"classified skill {class_id!r} was not loaded (loaded: "
            f"{[s.get('name') for s in skills]}) — the trace describes work against instructions "
            "that were never in the prompt"
        )
    prescribed = matched[0].get("evidence_steps") or []
    if not prescribed:
        return 0.0, {
            "skill": class_id,
            "unscoreable": f"skill {class_id!r} declares no evidence_steps",
            "prescribed": 0,
            "satisfied": 0,
            "unsatisfied_step_ids": [],
            "unattempted_step_ids": [],
            # Same keys on both branches: the UI reads components without knowing which one produced
            # it, so a key that exists only on the scoreable path becomes an undefined render.
            "undeclared_step_ids": [],
        }
    score, components = evidence_completeness(prescribed=prescribed, steps=steps)
    return score, {"skill": class_id, **components}


def downgrade_unsupported_reports(
    *, steps: list[ReasoningStep], observed_tools: set[str]
) -> list[ReasoningStep]:
    """Rewrite ``satisfied=True`` reports that no tool call supports into unattempted.

    The per-step outcome is model-supplied, so it is a claim. The recorded tool calls are evidence
    about the investigation itself, and an investigation that made no tool calls cannot have obtained
    data — whatever it reports. Rather than raise (which would discard a usable proposal over a
    reporting error), the unsupported claim is downgraded to ``None``: it scores as unsatisfied and
    stays visibly distinct from a step the agent said it tried and failed.

    Deliberately coarse — it fires only when the investigation made **no** data-returning tool call
    at all. Mapping individual steps to individual tools would require each skill to declare which
    tool satisfies which step, which the front matter does not carry, and inventing that mapping in
    Python would put the skill's contract in two places. The coarse check catches the case that
    actually matters (a proposal fabricated with no lookups) without pretending to more precision
    than the declaration supports.

    :param steps: the trace, including the ``evidence_step`` entries from ``coerce_step_reports``.
    :param observed_tools: short names of the tools that actually returned during the investigation.
    :returns: a new list with unsupported satisfied-claims set to ``satisfied=None``.
    """
    if observed_tools:
        return steps
    return [
        s.model_copy(update={"satisfied": None})
        if s.kind == "evidence_step" and s.satisfied is True
        else s
        for s in steps
    ]


def coerce_step_reports(*, raw: object, skill: str) -> list[ReasoningStep]:
    """Normalize the agent's per-step outcome reports into trace steps.

    Defensive by necessity: neither backend enforces the submit argument schema (the harness does not
    validate inline-function inputs, and the runtime parses a JSON message), so this arrives in
    whatever shape the model emitted. Every uninterpretable case degrades toward UNATTEMPTED rather
    than satisfied — a malformed report must never raise the score.

    :param raw: the submitted ``evidence_steps`` field, any shape (list, JSON string, or junk).
    :param skill: the skill that drove the investigation, recorded as the step's trace label.
    :returns: one ``kind="evidence_step"`` ReasoningStep per interpretable report; reports without a
        ``step_id`` are dropped, since guessing which step they meant would fabricate coverage.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []

    out: list[ReasoningStep] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        step_id = str(entry.get("step_id") or "").strip()
        if not step_id:
            continue
        satisfied = entry.get("satisfied")
        # Only a real bool counts. "yes"/1/"partial" are recorded as not-attempted, which scores the
        # same as unsatisfied but stays visibly distinct from a step the agent actually reported on.
        out.append(
            ReasoningStep(
                skill=skill,
                kind="evidence_step",
                reasoning=str(entry.get("note") or f"evidence step {step_id}"),
                step_id=step_id,
                satisfied=satisfied if isinstance(satisfied, bool) else None,
            )
        )
    return out
