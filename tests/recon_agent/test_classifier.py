"""Tests for the classifier over the SKILL.md catalog."""

from classifier import pick_class

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


def test_pick_class_selects_by_model_label_threshold_and_keeps_reasoning():
    res = pick_class(catalog=CATALOG, fake_llm=lambda c: ("timing", 0.9, "value date off by 1 day"))
    assert res.class_id == "timing"
    assert res.confidence == 0.9
    assert res.reasoning == "value date off by 1 day"


def test_low_confidence_falls_back_to_unknown_but_preserves_reasoning():
    res = pick_class(catalog=CATALOG, fake_llm=lambda c: ("timing", 0.4, "weak signal"))
    assert res.class_id == "unknown"  # below timing's 0.7 threshold
    assert res.confidence == 0.4
    assert "weak signal" in res.reasoning
