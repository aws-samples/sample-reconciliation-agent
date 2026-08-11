"""Tests for the computed composite confidence (consistency + grounding + verbalized)."""

import json

from backend.recon_core.confidence import composite_confidence, evidence_grounding
from llm import classify_with_consistency

from backend.recon_core.schema import ReasoningStep, ReconItem

ITEM = ReconItem(
    item_id="idp-n1.pdf",
    domain="cash",
    sides=[],
    attributes={
        "idp_attributes": {
            "GlobalAmount": "150800000.00",
            "BorrowerName": "CASCADE LOGISTICS HOLDINGS INC.",
            "EffectiveDate": "31-Dec-2026",
        }
    },
)


def _step(evidence):
    return ReasoningStep(skill="s", confidence=0.9, reasoning="r", evidence=evidence)


def test_evidence_grounding_fraction_of_cited_values_present_in_item():
    steps = [
        _step(
            [
                "GlobalAmount: 150800000.00",  # present
                "BorrowerName: CASCADE LOGISTICS HOLDINGS INC.",  # present
                "MaturityDate: 01-Jan-2030",  # NOT in the item -> hallucinated
            ]
        )
    ]
    g = evidence_grounding(item=ITEM, steps=steps)
    assert abs(g - 2 / 3) < 1e-9


def test_evidence_grounding_handles_formatting_noise_and_no_evidence():
    # Commas/case/spacing differences must not count as hallucination.
    steps = [_step(["global amount 150,800,000.00"])]
    assert evidence_grounding(item=ITEM, steps=steps) == 1.0
    # No evidence cited at all -> nothing verifiable -> 0.0 (be conservative).
    assert evidence_grounding(item=ITEM, steps=[_step([])]) == 0.0


def test_composite_weights_and_idp_penalty():
    c = composite_confidence(consistency=1.0, grounding=1.0, verbalized=1.0, idp_alerts=0)
    assert c == 1.0
    c = composite_confidence(consistency=1.0, grounding=0.5, verbalized=0.8, idp_alerts=0)
    assert abs(c - (0.45 * 1.0 + 0.35 * 0.5 + 0.20 * 0.8)) < 1e-9
    # Low-confidence IDP fields shave the composite by 10%.
    p = composite_confidence(consistency=1.0, grounding=1.0, verbalized=1.0, idp_alerts=2)
    assert abs(p - 0.9) < 1e-9


class _FakeCaller:
    """Stand-in for the Strands single-turn call; records the temperature of each sample."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.temps = []

    def __call__(self, *, model_id, system, prompt, max_tokens, temperature):
        """Return the next canned reply as ``(text, stop_reason)``."""
        self.temps.append(temperature)
        return json.dumps(self._replies.pop(0)), "end_turn"


CATALOG = [
    {"name": "timing", "description": "d", "severity": "LOW", "confidence_threshold": 0.5, "deterministic_eligible": False},
    {"name": "amount", "description": "d", "severity": "LOW", "confidence_threshold": 0.5, "deterministic_eligible": False},
]


def test_classify_with_consistency_majority_vote():
    # 2 of 3 samples agree on 'timing' -> consistency 2/3, verbalized = mean of majority votes.
    fc = _FakeCaller(
        [
            {"name": "timing", "confidence": 0.9, "reasoning": "a"},
            {"name": "amount", "confidence": 0.7, "reasoning": "b"},
            {"name": "timing", "confidence": 0.8, "reasoning": "c"},
        ]
    )
    name, verbalized, reasoning, consistency = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, samples=3, caller=fc
    )
    assert name == "timing"
    assert abs(consistency - 2 / 3) < 1e-9
    assert abs(verbalized - 0.85) < 1e-9  # mean(0.9, 0.8)
    assert reasoning in ("a", "c")  # reasoning comes from a majority-class sample
    # Sampling must use a diversity temperature (not the deterministic 0.2).
    assert all(t >= 0.5 for t in fc.temps)
