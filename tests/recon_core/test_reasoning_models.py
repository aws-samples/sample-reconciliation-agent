"""Tests for the classification-result and reasoning-step runtime output models."""

from backend.recon_core.schema import ClassificationResult, ReasoningStep


def test_classification_result_carries_reasoning_and_confidence():
    """Classification output pairs a class id with confidence and human-readable reasoning."""
    cr = ClassificationResult(
        class_id="timing-break",
        confidence=0.87,
        reasoning="Amounts match; value date differs by 1 business day.",
    )
    assert cr.class_id == "timing-break"
    assert cr.confidence == 0.87
    assert "value date" in cr.reasoning


def test_reasoning_step_captures_skill_reasoning_and_confidence():
    """Each reconciliation step records which skill ran, its confidence, reasoning, evidence."""
    step = ReasoningStep(
        skill="record-match-review",
        confidence=0.9,
        reasoning="Bank 100.00 vs ledger 100.00 within tolerance.",
        evidence=["bank.amount=100.00", "ledger.amount=100.00"],
    )
    assert step.skill == "record-match-review"
    assert step.confidence == 0.9
    assert step.evidence[0].startswith("bank.amount")
