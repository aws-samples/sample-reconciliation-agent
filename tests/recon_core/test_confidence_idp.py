"""The both-backends-agree invariant for evidence completeness.

Both backends score the same fraction of the same skill's required evidence steps, so the invariant is
"two call sites reach one formula" — not "two formulas agree". The tests assert it by driving each
backend's OWN entry point — ``agent.score_by_evidence`` and ``intake.build_proposal`` — rather than by
calling the shared function twice, which would pass even if a backend stopped calling it.

Per-function coverage of the scoring itself lives in ``tests/recon_core/test_confidence.py``.
"""

import pytest

from agent import score_by_evidence

from backend.harness_agent import intake
from backend.harness_agent.stream import StreamResult
from backend.recon_core.schema import EvidenceStep, Proposal, ReconItem

ITEM = ReconItem(
    item_id="idp-1",
    domain="loan-servicing",
    sides=[{"name": "ledger", "attributes": {"reference": "DDTL-A-0001"}}],
)

# One break-type skill with four required evidence steps, plus the `unknown` fallback the harness's
# classifier needs present in the catalog.
SKILLS = [
    {
        "name": "record-match-review",
        "confidence_threshold": 0.7,
        "evidence_steps": [
            EvidenceStep(id="fund_alias_match", description="fund alias"),
            EvidenceStep(id="expected_entry_match", description="expected entry"),
            EvidenceStep(id="amount_within_tolerance", description="amount"),
            EvidenceStep(id="entry_direction", description="direction"),
        ],
    },
    {"name": "unknown", "confidence_threshold": 0.0},
]

# The SAME skills as the HARNESS actually receives them. This must NOT be `SKILLS`: the harness has
# no skill-loading tool, so it only ever sees `skills-catalog.json`, where every EvidenceStep has been
# projected to a plain dict by `catalog_entry`. Handing both backends the model form lets
# `evidence_completeness` read `s.required` and still pass every test here, while the live harness dies
# with `AttributeError: 'dict' object has no attribute 'required'` the moment its classification starts
# working. The whole point of a both-backends test is that each backend gets its own real input.
HARNESS_CATALOG = [
    {**s, "evidence_steps": [e.model_dump(mode="json") for e in s.get("evidence_steps", [])]}
    for s in SKILLS
]

# Three of the four required steps obtained data => 0.75 on either backend.
REPORTS = [
    {"step_id": "fund_alias_match", "satisfied": True},
    {"step_id": "expected_entry_match", "satisfied": True},
    {"step_id": "amount_within_tolerance", "satisfied": True},
    {"step_id": "entry_direction", "satisfied": False},
]

EXPECTED_COMPONENTS = {
    "skill": "record-match-review",
    "prescribed": 4,
    "satisfied": 3,
    "unsatisfied_step_ids": ["entry_direction"],
    "unattempted_step_ids": [],
    "undeclared_step_ids": [],
}


def _runtime_score(*, observed_tools: set[str] | None = None) -> tuple[float, dict]:
    """Score the reports through the RUNTIME backend's entry point.

    :param observed_tools: short names of the tools that returned data. Defaults to the same
        single-tool seed the harness helper uses, so the existing tests keep their meaning; pass
        ``set()`` to model an investigation that reported steps without calling anything.
    :returns: ``(confidence, confidence_components)`` as the runtime would persist them.
    """
    from backend.recon_core.confidence import coerce_step_reports

    prop = Proposal(
        item_id="idp-1",
        class_id="record-match-review",
        classification_reasoning="c",
        resolution="Mark the draw cancelled.",
        # `confidence` is left at its 0.0 default deliberately: the assertion below is that
        # `score_by_evidence` WROTE 0.75, and starting from the fail-safe default shows that more
        # directly than starting from a seeded number and watching it get overwritten.
        steps=coerce_step_reports(raw=REPORTS, skill="record-match-review"),
    )
    score_by_evidence(
        prop=prop,
        skills=SKILLS,
        observed_tools={"search_ledger"} if observed_tools is None else observed_tools,
    )
    return prop.confidence, prop.confidence_components


def _harness_score(*, observed_tools: set[str] | None = None) -> tuple[float, dict]:
    """Score the same reports through the HARNESS backend's entry point.

    :param observed_tools: short names of the tools that returned data — seeded into the stream's
        ``tool_outputs``. Defaults to the single-tool seed; pass ``set()`` for a stream in which no
        tool returned anything.
    :returns: ``(confidence, confidence_components)`` as the harness would persist them.
    """
    stream = StreamResult()
    for tool in {"search_ledger"} if observed_tools is None else observed_tools:
        stream.tool_outputs[tool] = [{"rows": [{"reference": "DDTL-A-0001"}]}]
    prop = intake.build_proposal(
        item=ITEM,
        submitted={
            "class_name": "record-match-review",
            "classification_reasoning": "r",
            "resolution": "Mark the draw cancelled.",
            "evidence": ["reference: DDTL-A-0001"],
            "evidence_steps": REPORTS,
        },
        stream_result=stream,
        catalog=HARNESS_CATALOG,
    )
    return prop.confidence, prop.confidence_components


def test_both_backends_agree_for_the_same_reported_steps() -> None:
    """A divergence would surface as the same case auto-resolving or escalating by luck of backend."""
    runtime_score, runtime_components = _runtime_score()
    harness_score, harness_components = _harness_score()
    assert runtime_score == harness_score == 0.75
    # Whole-dict equality, not key-by-key. Both backends now persist exactly what the shared scorer
    # returned and nothing else, so an extra key on either side is itself the failure this file exists
    # to catch — and a key-by-key loop over an expected subset would sail straight past it.
    assert runtime_components == harness_components == EXPECTED_COMPONENTS


def test_neither_backend_stores_anything_the_model_said_about_itself() -> None:
    """Neither backend may write a diagnostic key the other does not, and neither may write a model
    self-report at all.

    Extra keys are what makes the two diverge: a `consistency` on one side, a `verbalized` or a
    `grounding` on either, and the same case shows a different confidence breakdown depending on which
    backend happened to run it — with numbers on display that are not scores. Only the completeness
    breakdown belongs here.
    """
    _, runtime_components = _runtime_score()
    _, harness_components = _harness_score()
    for components in (runtime_components, harness_components):
        assert "consistency" not in components
        assert "verbalized" not in components
        assert "grounding" not in components


def test_the_shared_score_is_not_a_weighted_blend_on_either_backend() -> None:
    """3-of-4 prescribed steps is 0.75 on both backends, with no second number anywhere that could
    move it.

    The arithmetic is the point. `test_single_confidence_signal.py` proves no such number exists as a
    field or a name; this proves the score is the bare fraction, so a blend reintroduced through some
    path those greps do not cover still fails here.
    """
    runtime_score, _ = _runtime_score()
    harness_score, _ = _harness_score()
    assert runtime_score == harness_score == pytest.approx(3 / 4)


def test_the_score_is_shape_blind_so_a_catalog_dict_scores_as_a_model_step():
    """The two backends hand the scorer two DIFFERENT shapes of the same declaration.

    The runtime loads skills and gets `EvidenceStep` models; the harness only has the JSON catalog.
    Both must reach the same number — identical, not close — or the two backends disagree for a reason
    that has nothing to do with the evidence.
    """
    from backend.recon_core.confidence import coerce_step_reports, evidence_completeness

    steps = coerce_step_reports(raw=REPORTS, skill="record-match-review")
    model_score, model_components = evidence_completeness(
        prescribed=SKILLS[0]["evidence_steps"], steps=steps
    )
    dict_score, dict_components = evidence_completeness(
        prescribed=HARNESS_CATALOG[0]["evidence_steps"], steps=steps
    )
    assert model_score == dict_score
    assert model_components == dict_components


def test_neither_backend_credits_a_satisfied_claim_no_tool_supports() -> None:
    """`satisfied` is the model's own claim, and it is the ONLY input to the score that authorizes an
    unattended ledger write. A claim for a step whose tool returned nothing must not count on EITHER
    backend: if one downgrades it and the other does not, an identical trace scores 1.0 on one backend
    and 0.75 on the other.
    """
    runtime_score, _ = _runtime_score(observed_tools=set())
    harness_score, _ = _harness_score(observed_tools=set())
    assert runtime_score == harness_score == 0.0
