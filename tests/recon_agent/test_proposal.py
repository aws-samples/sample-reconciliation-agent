"""Tests for the proposal builder (classify + skills -> propose with reasoning)."""

from backend.recon_core.schema import ClassificationResult, ReasoningStep, ReconItem, ReconSide
from proposal import build_proposal


def test_build_proposal_carries_classification_and_step_reasoning():
    item = ReconItem(
        item_id="i-9",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
    )
    classification = ClassificationResult(
        class_id="timing", confidence=0.9, reasoning="value date off by 1 day"
    )
    prop = build_proposal(
        item=item,
        classification=classification,
        fake_investigate=lambda it, skills: (
            "apply to fund X",
            0.83,
            [
                ReasoningStep(
                    skill="record-match-review",
                    confidence=0.83,
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
    assert prop.classification_confidence == 0.9
    assert prop.confidence == 0.83
    assert prop.resolution == "apply to fund X"
    assert prop.steps[0].skill == "record-match-review"
    assert prop.steps[0].reasoning == "amounts match within tolerance"
    assert prop.evidence == ["bank=100.00", "ledger=100.00"]
