"""Shared domain schema for the reconciliation platform.

Single source of truth for all data shapes crossing component boundaries. Classification
types are NOT defined here — they live in the SKILL.md files. This module holds the
reconciliation-flow shapes plus the agent's runtime outputs (classification result,
reasoning steps, proposal).
"""

from typing import Literal

from datetime import datetime, timezone
from pydantic import BaseModel, Field, model_validator


class ReconSide(BaseModel):
    """One side of a reconciliation item (e.g. a bank record or a ledger record)."""

    name: str
    attributes: dict[str, str] = Field(default_factory=dict)


class ReconItem(BaseModel):
    """A single item to reconcile, carrying its two (or more) sides and provenance."""

    item_id: str
    domain: str
    sides: list[ReconSide]
    source_refs: list[str] = Field(default_factory=list)
    # Free-form passthrough bag (e.g. the IDP hook stores idp_class / idp_attributes here).
    attributes: dict = Field(default_factory=dict)
    tier: int = 1


class ClassificationResult(BaseModel):
    """The agent's classification output: the chosen type and why.

    ``class_id`` matches a SKILL.md classification type.
    """

    class_id: str
    reasoning: str  # human-readable why-this-class, surfaced in the UI


class EvidenceStep(BaseModel):
    """One prescribed investigation step a skill declares in its front matter.

    The declared set is the DENOMINATOR of the evidence-completeness confidence score
    (``backend/recon_core/confidence.py``), so a malformed declaration silently changes every
    score for that skill — hence the strict ``required`` field rather than pydantic's default
    coercion.
    """

    id: str = Field(min_length=1)
    description: str = Field(min_length=1)
    # strict: a hand-typed "true"/1 in a UI-editable file must fail, not coerce.
    required: bool = Field(default=True, strict=True)


class SkillResultSpec(BaseModel):
    """What cardinality of answer a skill is asked to return.

    ``single_match`` means the skill must name exactly one record or say it found none;
    ``ranked_set`` means it returns up to ``max_candidates`` ordered candidates and the UI renders
    the ranking. The distinction is the skill's to declare, not the agent's to infer.
    """

    cardinality: Literal["single_match", "ranked_set"]
    max_candidates: int = Field(default=1, ge=1, le=25)

    @model_validator(mode="after")
    def _single_match_implies_one(self) -> "SkillResultSpec":
        """Reject a declaration whose cardinality and candidate cap disagree.

        :returns: self, unchanged, when the two agree.
        :raises ValueError: when single_match asks for more than one candidate.
        """
        if self.cardinality == "single_match" and self.max_candidates != 1:
            raise ValueError("single_match must declare max_candidates: 1")
        return self


class ReasoningStep(BaseModel):
    """One typed entry in the agent trace.

    Generalized from a plain investigation step into a discriminated entry so the trace can
    show the agent's real work: lesson recall, classification, skill loading, each tool
    invocation, the executed write, and the final proposal.

    Every field beyond ``{skill, confidence, reasoning, evidence}`` is optional so that any trace
    already persisted in DynamoDB still validates on read: ``kind`` defaults to ``"propose"`` and
    ``step_id``/``satisfied`` default to ``None``, which scores as fully unattempted. Cases are
    long-lived records, so a required field added here would make old cases unreadable rather than
    merely unscored.

    ``confidence`` is accepted for those persisted traces and is read by NO scoring path, nor rendered
    per-entry by the UI. Do not add a dependency on it: it is a model self-report, and the gate scores
    evidence completeness instead precisely because a self-report is unfalsifiable. Floats are
    converted to ``Decimal`` before any DynamoDB write.
    """

    skill: str  # which SKILL.md / phase drove this entry (also the trace label)
    # OPTIONAL and written by nobody. Accepted so traces persisted before 2026-09-04 still validate
    # on read. Read by no scoring path and not rendered per-entry (the case screen's trace eyebrow
    # says so outright). Do NOT give this a 0.0 default: a required float that every writer fills
    # with a meaningless value is how it came to look load-bearing, and a 0.0 on the trace reads to a
    # human as "the agent was not confident" rather than "nobody measured this".
    confidence: float | None = None
    reasoning: str  # human-readable why, surfaced in the UI
    evidence: list[str] = Field(default_factory=list)
    # Discriminator + kind-specific optional fields (all default None for back-compat):
    kind: Literal[
        "lesson_recall",
        "classify",
        "skill_load",
        "tool_call",
        # One prescribed evidence step the driving skill declared, and whether it was obtained.
        "evidence_step",
        "execute",
        "propose",
    ] = "propose"
    tool: str | None = None  # tool_call: the invoked tool's name (e.g. "search_ledger")
    tool_input: dict | None = None  # tool_call: the arguments sent to the tool
    tool_output: str | None = None  # tool_call: a summary of what the tool returned
    action: dict | None = None  # execute: the structured write that was performed
    outcome: str | None = None  # execute: "executed" | "failed: <msg>" | "escalated"
    # Evidence-completeness scoring. ``step_id`` matches an ``evidence_steps[].id``
    # in the skill that drove this entry; ``satisfied`` says whether the step obtained the data it
    # prescribed.
    #
    # ``satisfied`` is TRI-STATE on purpose. ``None`` means "not attempted", ``False`` means
    # "attempted and came back empty". ``evidence_completeness`` scores both as unsatisfied, but
    # collapsing them here would erase the distinction the case UI and the eval set need: "the agent
    # never looked" and "the agent looked and the data is not there" call for different human
    # responses, and only the second one is evidence about the break.
    step_id: str | None = None
    satisfied: bool | None = None
    # Wall-clock stamp of when this step was RECORDED (UTC ISO-8601) — every span in the
    # trace carries a review timestamp. default_factory so all creation sites get it free.
    ts: str | None = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )


class InvestigationResult(BaseModel):
    """What one investigation run hands back to ``proposal.build_proposal``.

    Replaces a 3-, 4- or 5-tuple dispatched on by length. The tuple form made a fake that returned
    the wrong number of values a silently different contract instead of an error — and it could not
    survive removing a member, because dropping one collided every arity with its neighbour.

    Carries NO confidence. The only confidence a proposal has is the evidence-completeness score, and
    that is computed from ``steps`` afterwards by ``recon_core.confidence.score_proposal``.
    """

    resolution: str
    steps: list[ReasoningStep] = Field(default_factory=list)
    # None when the investigation isolated nothing safely actionable — such an item always escalates.
    proposed_action: dict | None = None
    # None when no counterparty contact is warranted; see ``Proposal.proposed_email`` for the shape.
    proposed_email: dict | None = None
    # The investigation's ``search_notices`` result set, for the Matched Notices panel; see
    # ``Proposal.notice_search``. Travels on THIS object because the runtime backend's investigator is
    # the only place that sees those results — ``proposal.build_proposal`` cannot re-derive them.
    notice_search: dict | None = None


class Proposal(BaseModel):
    """The agent's propose-only output for an escalated item.

    Carries the classification reasoning and the per-reconciliation-step reasoning so the UI can
    show the full chain. There is exactly ONE confidence on it — ``confidence``, computed from the
    reported evidence steps by ``recon_core.confidence.score_proposal`` — and no field anywhere in
    this model holds a number the model reported about itself. All float fields are converted to
    ``Decimal`` before any DynamoDB write.
    """

    item_id: str
    class_id: str
    classification_reasoning: str
    resolution: str
    # COMPUTED evidence completeness (satisfied / prescribed required steps); drives auto-resolve.
    # 0.0 until `score_proposal` writes it — the fail-safe value, since an unscored proposal is below
    # every threshold and escalates.
    confidence: float = 0.0
    # The breakdown behind `confidence`: which of the classified skill's prescribed steps obtained
    # data, and which did not and why. Nothing the model reports about its own certainty belongs here.
    # Both agent backends write the same keys, which the test suite asserts as an invariant, because a
    # case that displays a different breakdown depending on which backend happened to run it is
    # indistinguishable from a scoring bug.
    confidence_components: dict = Field(default_factory=dict)
    steps: list[ReasoningStep] = Field(default_factory=list)
    # Structured, executable action derived from the investigation (e.g.
    # {"tool": "set_draw_status", "reference", "status", "reason"}). ``None`` when the
    # investigation found nothing safely actionable — such an item always escalates and is
    # never auto-executed, regardless of confidence.
    proposed_action: dict | None = None
    # Counterparty email draft awaiting human approval, or ``None`` when the investigation needs no
    # outbound contact. Deliberately a SEPARATE field rather than a second entry in
    # ``proposed_action``: the gateway interceptor's provenance check reads
    # ``proposed_action.reference`` directly, so making that field a list would break it for cases
    # already in flight.
    #
    # Shape: ``{recipient, recipient_hint, subject, body, draft_status, revision,
    # approved_revision, edited_by, edited_at, send_attempted_at, sent_at}``. ``recipient`` starts
    # ``None`` — the model supplies only ``recipient_hint`` (a counterparty NAME) and the analyst
    # supplies the address, because items arrive from documents an outside party sent and a
    # model-authored recipient is attacker-influenceable.
    #
    # ``draft_status`` is ``pending | approved | discarded | sent``. It is a field on the draft, NOT
    # a ``CaseStatus``: the draft's lifecycle is not the case's, and every new case state would also
    # have to be taught to ``status.can_transition`` and to the interceptor that enforces it.
    proposed_email: dict | None = None
    # The FULL result set of every ``search_notices`` call — the notices the investigation actually
    # reasoned over, shown in the case's Matched Notices panel.
    #
    # A separate attribute rather than something read back out of ``steps`` because the trace's
    # ``tool_output`` is a 600-character display summary (``harness_agent.stream._summarize``) and one
    # notice row is larger than that, so the trace only ever holds a JSON *fragment*. The UI used to
    # re-parse that fragment, fail, and report "matched no notices" on cases that had matched five.
    #
    # Shape: ``{searched: bool, rows: list[dict], matched_on: list[str], error: str | None,
    # omitted: int}`` — see ``recon_core.proposal_service.notice_search_summary``, the single
    # derivation both backends use. ``None`` on a proposal built without a recorded notice search.
    notice_search: dict | None = None

    @property
    def evidence(self) -> list[str]:
        """Flattened evidence across steps (for post-back / UI summaries)."""
        return [e for s in self.steps for e in s.evidence]
