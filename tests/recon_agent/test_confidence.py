"""The runtime backend's k-sample classifier.

The vote produces no number at all any more — it returns a class and its reasoning. It still matters,
and more than the deleted figures ever did: the class it picks names the ONE skill whose prescribed
required steps form the denominator of the evidence-completeness score (tested separately), so getting
the majority or the diversity temperature wrong sends the agent down the wrong playbook and then scores
it against the wrong checks.
"""

import json

from llm import classify_with_consistency

from backend.recon_core.schema import ReconItem

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
    {
        "name": "timing",
        "description": "d",
        "severity": "LOW",
        "confidence_threshold": 0.5,
        "deterministic_eligible": False,
    },
    {
        "name": "amount",
        "description": "d",
        "severity": "LOW",
        "confidence_threshold": 0.5,
        "deterministic_eligible": False,
    },
]


def test_classify_with_consistency_majority_vote():
    # 2 of 3 samples agree on 'timing'. The dissenting sample is the FIRST reply, so a vote that
    # returned the first draw rather than the majority would pass 'amount' back.
    fc = _FakeCaller(
        [
            {"name": "amount", "reasoning": "b"},
            {"name": "timing", "reasoning": "a"},
            {"name": "timing", "reasoning": "c"},
        ]
    )
    name, reasoning = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, samples=3, caller=fc
    )
    assert name == "timing"
    assert reasoning in ("a", "c")  # reasoning comes from a majority-class sample
    # Sampling must use a diversity temperature (not the deterministic 0.2) — identical draws would
    # make the vote unanimous by construction and cost it the stability it exists for.
    assert all(t >= 0.5 for t in fc.temps)


def test_a_stale_prompt_still_asking_for_a_confidence_does_not_break_the_vote() -> None:
    """The deploy window: new code running against the OLD system prompt.

    Both system prompts are create-only S3 objects (``lifecycle { ignore_changes }``), so
    ``terraform apply`` ships this code WITHOUT shipping the rewritten prompt — the seed push is a
    separate manual step. Until it lands, the live model is still being told to "state your reasoning
    with a confidence in [0,1]" and will duly add the key. Reading the reply by name rather than by
    shape is what makes that window harmless, so it is asserted rather than left to inspection.

    :returns: None.
    """
    fc = _FakeCaller(
        [
            {"name": "timing", "reasoning": "a", "confidence": 0.91},
            {"name": "timing", "reasoning": "c", "confidence": 0.2},
            # Also the shape where the model nests it, which the old prompt's wording invited.
            {"name": "timing", "reasoning": "d", "classification": {"confidence": 0.5}},
        ]
    )
    name, reasoning = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, samples=3, caller=fc
    )

    assert name == "timing"
    assert reasoning in ("a", "c", "d")
