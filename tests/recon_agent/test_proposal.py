"""Tests for the proposal builder (classify + skills -> propose with reasoning)."""

from backend.recon_core.schema import (
    ClassificationResult,
    InvestigationResult,
    ReasoningStep,
    ReconItem,
    ReconSide,
)
from proposal import build_proposal


def test_build_proposal_carries_classification_and_step_reasoning():
    item = ReconItem(
        item_id="i-9",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
    )
    classification = ClassificationResult(class_id="timing", reasoning="value date off by 1 day")
    prop = build_proposal(
        item=item,
        classification=classification,
        fake_investigate=lambda it, skills: InvestigationResult(
            resolution="apply to fund X",
            steps=[
                ReasoningStep(
                    skill="record-match-review",
                    reasoning="amounts match within tolerance",
                    evidence=["bank=100.00", "ledger=100.00"],
                )
            ],
        ),
        skills=["record-match-review"],
    )
    assert prop.item_id == "i-9"
    assert prop.class_id == "timing"
    assert prop.classification_reasoning == "value date off by 1 day"
    # build_proposal does not score — `agent.score_by_evidence` writes `confidence` from the trace.
    assert prop.confidence == 0.0
    assert prop.resolution == "apply to fund X"
    assert prop.steps[0].skill == "record-match-review"
    assert prop.steps[0].reasoning == "amounts match within tolerance"
    assert prop.evidence == ["bank=100.00", "ledger=100.00"]


def test_build_proposal_takes_a_typed_investigation_result() -> None:
    """The investigator returns one object, so a fake cannot silently change the contract by
    returning the wrong number of values."""
    result = InvestigationResult(
        resolution="Mark the draw cancelled.",
        steps=[],
        proposed_action={"tool": "set_draw_status", "reference": "DDTL-A-0001"},
    )
    prop = build_proposal(
        item=ReconItem(
            item_id="i-10",
            domain="cash",
            sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
        ),
        classification=ClassificationResult(class_id="timing", reasoning="why"),
        fake_investigate=lambda it, skills: result,
        skills=[],
    )
    assert prop.resolution == "Mark the draw cancelled."
    assert prop.proposed_action["reference"] == "DDTL-A-0001"
    assert prop.proposed_email is None
