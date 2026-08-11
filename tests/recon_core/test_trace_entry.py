"""Typed trace entries + structured proposed_action on the agent's outputs.

The agent trace generalizes ReasoningStep into a typed entry (kind discriminator) that can
represent lesson recall, classification, skill loading, tool invocations, the executed write,
and the final proposal — while staying backward-compatible with old-style steps.
"""

from backend.recon_core.schema import Proposal, ReasoningStep


def test_reasoning_step_defaults_to_propose_kind_and_back_compat():
    """An old-style step (skill/confidence/reasoning/evidence) still validates; kind defaults."""
    step = ReasoningStep(
        skill="document-cross-reference",
        confidence=0.9,
        reasoning="fields consistent with a draw cancellation",
        evidence=["GlobalAmount: $14,000,000.00"],
    )
    assert step.kind == "propose"
    assert step.tool is None
    assert step.tool_input is None
    assert step.tool_output is None
    assert step.action is None
    assert step.outcome is None


def test_reasoning_step_accepts_tool_call_fields():
    """A tool_call entry carries the tool name, its input args, and the returned output."""
    step = ReasoningStep(
        skill="document-cross-reference",
        confidence=0.0,
        reasoning="looked up the matching ledger posting",
        kind="tool_call",
        tool="search_ledger",
        tool_input={"reference": "DDTL-A-0001"},
        tool_output="1 posting: DDTL-A-0001 $14,000,000.00 2026-01-22",
    )
    assert step.kind == "tool_call"
    assert step.tool == "search_ledger"
    assert step.tool_input == {"reference": "DDTL-A-0001"}
    assert "DDTL-A-0001" in step.tool_output


def test_reasoning_step_accepts_execute_fields():
    """An execute entry carries the structured action performed and its outcome."""
    step = ReasoningStep(
        skill="document-cross-reference",
        confidence=0.0,
        reasoning="executed the proposed status change",
        kind="execute",
        action={"tool": "set_draw_status", "reference": "DDTL-A-0001", "status": "Cancelled"},
        outcome="executed",
    )
    assert step.kind == "execute"
    assert step.action["status"] == "Cancelled"
    assert step.outcome == "executed"


def test_proposal_carries_structured_proposed_action():
    """Proposal holds an executable action (None when nothing is safely actionable)."""
    prop = Proposal(
        item_id="idp-1",
        class_id="document-cross-reference",
        classification_confidence=0.95,
        classification_reasoning="loan draw cancellation notice",
        resolution="Mark the draw cancelled.",
        confidence=0.97,
        proposed_action={
            "tool": "set_draw_status",
            "reference": "DDTL-A-0001",
            "status": "Cancelled",
            "reason": "DRAW DATE HAS BEEN PUSHED",
        },
    )
    assert prop.proposed_action["reference"] == "DDTL-A-0001"

    # Non-executable proposals (no clean ledger match) carry no action.
    prop2 = Proposal(
        item_id="idp-2",
        class_id="unknown",
        classification_confidence=0.4,
        classification_reasoning="ambiguous",
        resolution="Escalate for manual review.",
        confidence=0.4,
    )
    assert prop2.proposed_action is None
