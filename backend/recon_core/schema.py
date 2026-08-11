"""Shared domain schema for the reconciliation platform.

Single source of truth for all data shapes crossing component boundaries. Classification
types are NOT defined here — they live in the SKILL.md files. This module holds the
reconciliation-flow shapes plus the agent's runtime outputs (classification result,
reasoning steps, proposal).
"""

from typing import Literal

from datetime import datetime, timezone
from pydantic import BaseModel, Field


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
    """The agent's classification output: chosen type, confidence, and why.

    ``confidence`` is an in-memory float; it is converted to ``Decimal`` before any
    DynamoDB write. ``class_id`` matches a SKILL.md classification type.
    """

    class_id: str
    confidence: float
    reasoning: str  # human-readable why-this-class, surfaced in the UI


class ReasoningStep(BaseModel):
    """One typed entry in the agent trace.

    Generalized from a plain investigation step into a discriminated entry so the trace can
    show the agent's real work: lesson recall, classification, skill loading, each tool
    invocation, the executed write, and the final proposal. Back-compatible — an old-style
    ``{skill, confidence, reasoning, evidence}`` step still validates (``kind`` defaults to
    ``"propose"``, the new fields default to ``None``).

    ``confidence`` is retained in the model (a weak per-step signal used only by internal
    calcs); the UI no longer renders it per-entry. Floats are converted to ``Decimal`` before
    any DynamoDB write.
    """

    skill: str  # which SKILL.md / phase drove this entry (also the trace label)
    confidence: float
    reasoning: str  # human-readable why, surfaced in the UI
    evidence: list[str] = Field(default_factory=list)
    # Discriminator + kind-specific optional fields (all default None for back-compat):
    kind: Literal[
        "lesson_recall", "classify", "skill_load", "tool_call", "execute", "propose"
    ] = "propose"
    tool: str | None = None  # tool_call: the invoked tool's name (e.g. "search_ledger")
    tool_input: dict | None = None  # tool_call: the arguments sent to the tool
    tool_output: str | None = None  # tool_call: a summary of what the tool returned
    action: dict | None = None  # execute: the structured write that was performed
    outcome: str | None = None  # execute: "executed" | "failed: <msg>" | "escalated"
    # Wall-clock stamp of when this step was RECORDED (UTC ISO-8601) — every span in the
    # trace carries a review timestamp. default_factory so all creation sites get it free.
    ts: str | None = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )


class Proposal(BaseModel):
    """The agent's propose-only output for an escalated item.

    Carries both the classification reasoning/confidence and the per-reconciliation-step
    reasoning/confidence so the UI can show the full chain. All float fields are converted to
    ``Decimal`` before any DynamoDB write.
    """

    item_id: str
    class_id: str
    classification_confidence: float
    classification_reasoning: str
    resolution: str
    confidence: float  # COMPUTED composite (consistency/grounding/verbalized); drives auto-resolve
    # Transparency breakdown of the composite (consistency, grounding, verbalized, idp_alerts).
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

    @property
    def evidence(self) -> list[str]:
        """Flattened evidence across steps (for post-back / UI summaries)."""
        return [e for s in self.steps for e in s.evidence]
