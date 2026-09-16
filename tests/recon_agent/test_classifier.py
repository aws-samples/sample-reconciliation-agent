"""Tests for the classifier over the SKILL.md catalog."""

import logging

from classifier import pick_class

from backend.recon_core.schema import ClassificationResult

# catalog entries as returned by skills_loader.catalog()
CATALOG = [
    {
        "name": "timing",
        "description": "Timing friction",
        "severity": "LOW",
        "confidence_threshold": 0.7,
        "deterministic_eligible": True,
    },
    {
        "name": "unknown",
        "description": "Unknown break",
        "severity": "LOW",
        "confidence_threshold": 0.5,
        "deterministic_eligible": False,
    },
]


def test_a_known_class_is_kept_whatever_the_model_thought_of_itself() -> None:
    """A confidence floor on the model's own pick has one effect: turning good classifications into
    ``unknown``.

    ``unknown`` declares no evidence_steps, so such a case scores 0.0 and cannot auto-resolve however
    complete its evidence is — a silent, unappealable escalation off a self-asserted number.
    """
    res = pick_class(catalog=CATALOG, fake_llm=lambda c: ("timing", "value date off by 1 day"))
    assert res.class_id == "timing"
    assert res.reasoning == "value date off by 1 day"
    # The result carries a label and a why, and structurally cannot carry a self-grade.
    assert "confidence" not in ClassificationResult.model_fields


def test_a_class_outside_the_catalog_is_still_unknown() -> None:
    """Membership is the real check, and the reasoning survives the fallback for the case screen.

    An unrecognized break has to escalate on the SCORE — ``unknown`` prescribes no steps, so its
    evidence completeness is 0.0 — rather than on a threshold the model could talk its way past.
    """
    res = pick_class(catalog=CATALOG, fake_llm=lambda c: ("invented", "weak signal"))
    assert res.class_id == "unknown"
    assert res.reasoning == "weak signal"


def test_a_class_disagreeing_with_tier1_is_logged(caplog) -> None:
    """The pick still stands — Tier-1's rule table cannot see the catalog and never overrules."""
    with caplog.at_level(logging.WARNING):
        res = pick_class(
            catalog=CATALOG,
            fake_llm=lambda c: ("timing", "why"),
            tier1_hint="record-match-review",
        )
    assert res.class_id == "timing"
    assert "record-match-review" in caplog.text


def test_agreement_with_tier1_logs_nothing(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        pick_class(catalog=CATALOG, fake_llm=lambda c: ("timing", "why"), tier1_hint="timing")
    assert caplog.text == ""
