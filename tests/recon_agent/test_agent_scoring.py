"""The runtime backend's proposal score is the evidence fraction, not a weighted composite.

The scoring lives in ``agent.score_by_evidence`` at module level rather than inline in the
`pragma: no cover` entrypoint, precisely so this test can reach it: the number that gates an
unattended ledger write must be covered by a test and not by inspection.
"""

from agent import observed_tools_from, score_by_evidence

from backend.recon_core.schema import EvidenceStep, Proposal, ReasoningStep, ReconItem, ReconSide

ITEM = ReconItem(
    item_id="i-1",
    domain="loan-servicing",
    sides=[ReconSide(name="ledger", attributes={"reference": "DDTL-A-0001"})],
)


def _skill_with_required(*ids: str) -> list[dict]:
    """One loaded skill named 'record-match-review' prescribing the given required steps.

    :param ids: the prescribed step ids, all required.
    :returns: a one-element loaded-skills list in ``parse_skill`` shape.
    """
    return [
        {
            "name": "record-match-review",
            "evidence_steps": [EvidenceStep(id=i, description=i) for i in ids],
        }
    ]


# The investigation actually called a tool and got rows back. Passed explicitly at every call site
# because `score_by_evidence` treats an unstated observed set as EMPTY — the fail-safe reading — and
# then downgrades every satisfied-claim, which would drive each score to 0.0 instead of the
# fraction these tests are about. The downgrade itself is covered in
# tests/recon_core/test_confidence.py and, cross-backend, in test_confidence_idp.py.
OBSERVED = {"search_ledger"}


def _proposal(reported: list[tuple[str, bool]]) -> Proposal:
    """A proposal whose trace carries one evidence_step entry per reported outcome.

    :param reported: ``(step_id, satisfied)`` pairs the agent claimed.
    :returns: the Proposal, with the model's own stated confidence at 0.9.
    """
    steps = [
        ReasoningStep(
            skill="s",
            reasoning="r",
            kind="evidence_step",
            step_id=sid,
            satisfied=sat,
        )
        for sid, sat in reported
    ]
    return Proposal(
        item_id="i-1",
        class_id="record-match-review",
        classification_reasoning="c",
        resolution="Mark the draw cancelled.",
        confidence=0.9,  # the model's own number
        steps=steps,
    )


def test_runtime_confidence_is_the_evidence_fraction() -> None:
    # A 4-required-step skill with 3 satisfied reports must score exactly 0.75 — no weighting, no
    # verbalized term, no IDP penalty.
    prop = _proposal([("a", True), ("b", True), ("c", True), ("d", False)])
    score_by_evidence(
        prop=prop, skills=_skill_with_required("a", "b", "c", "d"), observed_tools=OBSERVED
    )
    assert prop.confidence == 0.75
    assert prop.confidence_components["unsatisfied_step_ids"] == ["d"]


def test_the_models_own_number_is_neither_scored_nor_stored() -> None:
    """The model's self-report is not a term AND is not kept as a diagnostic.

    Asserting its ABSENCE, not just that it does not move the score: anything stored beside the real
    number gets displayed by the UI, and an unweighted 0.9 sitting next to a computed 0.50 reads as a
    second opinion on the score rather than as trivia about the model.
    """
    prop = _proposal([("a", True), ("b", False)])
    score_by_evidence(prop=prop, skills=_skill_with_required("a", "b"), observed_tools=OBSERVED)
    # 1 of 2 required steps, regardless of the model's 0.9.
    assert prop.confidence == 0.5
    assert "verbalized" not in prop.confidence_components
    assert "consistency" not in prop.confidence_components
    # Nor may anything else sit beside the score. A `grounding` figure carried as a "displayed
    # diagnostic" reads as a third opinion while reporting a structural 0.00.
    assert "grounding" not in prop.confidence_components


def test_an_unattempted_step_is_reported_separately_from_an_empty_one() -> None:
    """The two zero-credit outcomes call for different human responses."""
    prop = _proposal([("a", False)])
    score_by_evidence(prop=prop, skills=_skill_with_required("a", "b"), observed_tools=OBSERVED)
    assert prop.confidence == 0.0
    assert prop.confidence_components["unsatisfied_step_ids"] == ["a"]
    assert prop.confidence_components["unattempted_step_ids"] == ["b"]


def test_the_unknown_fallback_scores_zero_rather_than_failing_the_invocation() -> None:
    """`load(["unknown"])` is the classification fallback and prescribes nothing."""
    prop = _proposal([])
    prop.class_id = "unknown"
    score_by_evidence(prop=prop, skills=[{"name": "unknown"}], observed_tools=OBSERVED)
    assert prop.confidence == 0.0
    assert "declares no evidence_steps" in prop.confidence_components["unscoreable"]


def test_omitting_observed_tools_scores_zero_rather_than_crediting_the_claims() -> None:
    """The default has to fail SAFE, because the caller that forgets it is the one being guarded.

    ``observed_tools`` defaults to ``None`` so existing callers keep compiling, and a default that
    meant "assume the tools ran" would turn every un-updated call site into a silent full-credit
    path — exactly the unattended ledger write this score exists to withhold.
    """
    prop = _proposal([("a", True), ("b", True)])
    score_by_evidence(prop=prop, skills=_skill_with_required("a", "b"))
    assert prop.confidence == 0.0
    assert prop.confidence_components["unattempted_step_ids"] == ["a", "b"]


def test_a_tool_call_with_no_recorded_output_does_not_count_as_observed() -> None:
    """A ``tool_call`` step can exist with ``tool_output`` unset, so the step alone is not evidence.

    This pins the helper's contract, not a production scenario: the runtime's own producer
    (``strands_investigator._call``) always ``json.dumps`` the result, so an empty lookup records
    ``"{}"`` and DOES count as observed — see ``agent.observed_tools_from``'s scope note. The rule
    asserted here is what keeps the runtime aligned with the harness, where a call whose result block
    never arrived likewise leaves ``tool_outputs`` without the key.
    """
    steps = [
        ReasoningStep(skill="s", reasoning="hit", kind="tool_call", tool="search_ledger"),
        ReasoningStep(
            skill="s",
            reasoning="empty",
            kind="tool_call",
            tool="search_correspondence",
            tool_output="",
        ),
        ReasoningStep(
            skill="s",
            reasoning="rows",
            kind="tool_call",
            tool="search_notices",
            tool_output='{"rows": [1]}',
        ),
    ]
    # search_ledger left tool_output at None; search_correspondence returned an empty string.
    assert observed_tools_from(steps=steps) == {"search_notices"}


def test_evidence_step_entries_are_not_mistaken_for_observed_tools() -> None:
    """Only ``tool`` carries a tool name; an evidence_step reports on one and names none.

    Keyed off ``tool`` rather than ``kind`` so a future entry kind that also calls a tool is counted
    without editing this helper — but that means an entry with no ``tool`` must contribute nothing.
    """
    prop = _proposal([("a", True)])
    assert observed_tools_from(steps=prop.steps) == set()
