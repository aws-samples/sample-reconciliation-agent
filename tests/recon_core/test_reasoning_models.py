"""Tests for the classification-result and reasoning-step runtime output models."""

from backend.recon_core.schema import ClassificationResult, ReasoningStep


def test_classification_result_carries_reasoning():
    """Classification output pairs a class id with human-readable reasoning — and no self-grade."""
    cr = ClassificationResult(
        class_id="timing-break",
        reasoning="Amounts match; value date differs by 1 business day.",
    )
    assert cr.class_id == "timing-break"
    assert "value date" in cr.reasoning
    assert "confidence" not in ClassificationResult.model_fields


def test_reasoning_step_captures_skill_reasoning_and_evidence():
    """Each reconciliation step records which skill ran, its reasoning, and its evidence."""
    step = ReasoningStep(
        skill="record-match-review",
        reasoning="Bank 100.00 vs ledger 100.00 within tolerance.",
        evidence=["bank.amount=100.00", "ledger.amount=100.00"],
    )
    assert step.skill == "record-match-review"
    assert step.confidence is None
    assert step.evidence[0].startswith("bank.amount")
