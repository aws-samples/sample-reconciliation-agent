"""Evidence-completeness scoring: the checkable score that drives auto-resolution.

The composite's own tests live in ``tests/recon_core/test_confidence_idp.py`` (cross-backend
parity) and ``tests/recon_agent/test_confidence.py`` (weights). This module covers only
``evidence_completeness``, whose denominator comes from the skill's declaration rather than from
anything the model said about itself.
"""

import pytest

from backend.recon_core.confidence import (
    coerce_step_reports,
    downgrade_unsupported_reports,
    evidence_completeness,
    score_proposal,
)
from backend.recon_core.schema import EvidenceStep, ReasoningStep


def _prescribed(*specs: tuple[str, bool]) -> list[EvidenceStep]:
    """Build a prescribed-step list from (id, required) pairs.

    :param specs: one ``(id, required)`` pair per step.
    :returns: the EvidenceStep list.
    """
    return [EvidenceStep(id=i, description=i, required=r) for i, r in specs]


def _step(step_id: str, satisfied: bool | None) -> ReasoningStep:
    """Build a trace step carrying an evidence-step outcome.

    :param step_id: the prescribed step this entry reports on.
    :param satisfied: tri-state outcome.
    :returns: the ReasoningStep.
    """
    return ReasoningStep(
        skill="s",
        reasoning="r",
        kind="evidence_step",
        step_id=step_id,
        satisfied=satisfied,
    )


def test_three_of_four_required_steps_scores_exactly_075() -> None:
    prescribed = _prescribed(("a", True), ("b", True), ("c", True), ("d", True))
    steps = [_step("a", True), _step("b", True), _step("c", True), _step("d", False)]
    score, components = evidence_completeness(prescribed=prescribed, steps=steps)
    assert score == 0.75
    assert components == {
        "prescribed": 4,
        "satisfied": 3,
        "unsatisfied_step_ids": ["d"],
        "unattempted_step_ids": [],
        "undeclared_step_ids": [],
    }


def test_optional_steps_neither_dilute_nor_inflate() -> None:
    # An optional step is not in the denominator, and satisfying it cannot push the score past 1.0.
    prescribed = _prescribed(("a", True), ("opt", False))
    score, components = evidence_completeness(
        prescribed=prescribed, steps=[_step("a", True), _step("opt", True)]
    )
    assert score == 1.0
    assert components["prescribed"] == 1


def test_unattempted_and_unsatisfied_are_reported_separately() -> None:
    prescribed = _prescribed(("a", True), ("b", True))
    score, components = evidence_completeness(prescribed=prescribed, steps=[_step("a", False)])
    assert score == 0.0
    assert components["unsatisfied_step_ids"] == ["a"]
    assert components["unattempted_step_ids"] == ["b"]


def test_empty_prescribed_raises() -> None:
    # A zero denominator has no defensible value: 1.0 auto-resolves everything under a mis-declared
    # skill, 0.0 looks like a model failure. Either way the operator debugs the wrong thing.
    with pytest.raises(ValueError, match="no required evidence steps"):
        evidence_completeness(prescribed=_prescribed(("opt", False)), steps=[])


def test_an_undeclared_step_id_is_ignored_and_reported_not_raised() -> None:
    """A model that invents a step id must not destroy the investigation that produced it.

    Raising here costs a whole run, and it does happen live: the agent reports ``account_name_match``
    for a skill declaring ``expected_entry_match``, ``score_proposal`` propagates the ValueError out of
    the handler, and minutes of work plus several hundred tool calls are discarded — the case sits in
    IN_PROGRESS with no proposal and nothing to tell the analyst why.

    The invented id is not scoreable (it names no prescribed step), so it is dropped from the
    arithmetic and listed in ``undeclared_step_ids``. The prescribed step it was probably meant to
    report stays visible as unattempted, which is the conservative direction — it LOWERS the score.

    :returns: None.
    """
    score, components = evidence_completeness(
        prescribed=_prescribed(("a", True)), steps=[_step("typo", True)]
    )

    assert score == 0.0
    assert components["undeclared_step_ids"] == ["typo"]
    # The real step is still owed, and the human sees it as owed rather than as a crash.
    assert components["unattempted_step_ids"] == ["a"]


def test_an_undeclared_step_id_cannot_inflate_the_score() -> None:
    """The gate must be unreachable by inventing satisfied steps — the whole point of ignoring them.

    Two invented ids reported satisfied alongside one genuine required step must score 1/1, not 3/3
    and not 3/1: an undeclared id is neither numerator nor denominator.

    :returns: None.
    """
    score, components = evidence_completeness(
        prescribed=_prescribed(("a", True), ("b", True)),
        steps=[_step("a", True), _step("made_up", True), _step("also_made_up", True)],
    )

    assert score == 0.5  # 1 of 2 required, NOT 3 of 2
    assert components["prescribed"] == 2
    assert components["satisfied"] == 1
    assert components["undeclared_step_ids"] == ["made_up", "also_made_up"]  # report order


def test_a_repeated_undeclared_step_id_is_listed_once() -> None:
    """A retried tool call reports the same step twice; the operator needs the id, not the count.

    :returns: None.
    """
    _, components = evidence_completeness(
        prescribed=_prescribed(("a", True)), steps=[_step("typo", True), _step("typo", False)]
    )
    assert components["undeclared_step_ids"] == ["typo"]


def test_undeclared_step_ids_is_always_present_even_when_empty() -> None:
    """An absent key renders as "no problem" in the UI whether the check ran or not.

    :returns: None.
    """
    _, components = evidence_completeness(
        prescribed=_prescribed(("a", True)), steps=[_step("a", True)]
    )
    assert components["undeclared_step_ids"] == []


def test_the_last_report_for_a_step_wins() -> None:
    # A retried tool call legitimately reports the same step twice. The final outcome is the
    # investigation's conclusion; an "any satisfied wins" rule would let a lucky first hit outrank a
    # later contradiction, and "all must be satisfied" would punish the retry.
    prescribed = _prescribed(("a", True))
    steps = [_step("a", True), _step("a", False)]
    assert evidence_completeness(prescribed=prescribed, steps=steps)[0] == 0.0


def test_trace_entries_that_are_not_evidence_steps_are_ignored() -> None:
    """skill_load/tool_call/propose entries carry no step_id and must not raise or count.

    These entries also set no ``confidence`` at all — the scorer does not read it and nothing writes
    it, so there is no self-reported number here to outrank the evidence.
    """
    prescribed = _prescribed(("a", True))
    steps = [
        ReasoningStep(skill="s", reasoning="loaded", kind="skill_load"),
        _step("a", True),
        ReasoningStep(skill="s", reasoning="done", kind="propose"),
    ]
    assert evidence_completeness(prescribed=prescribed, steps=steps)[0] == 1.0


# --- score_proposal: the one entry point both backends call --------------------------------------


def test_score_proposal_resolves_the_classified_skill() -> None:
    skills = [
        {"name": "record-match-review", "evidence_steps": [EvidenceStep(id="a", description="a")]},
        {
            "name": "ledger-status-resolution",
            "evidence_steps": [EvidenceStep(id="z", description="z")],
        },
    ]
    score, components = score_proposal(
        skills=skills, class_id="record-match-review", steps=[_step("a", True)]
    )
    assert score == 1.0
    assert components["skill"] == "record-match-review"


def test_score_proposal_on_an_unscoreable_skill_is_zero_not_a_crash() -> None:
    # 'unknown' is the classification fallback and declares no evidence_steps. Escalating at 0.0 is
    # the correct outcome; raising would turn an unclassifiable break into a failed invocation.
    score, components = score_proposal(skills=[{"name": "unknown"}], class_id="unknown", steps=[])
    assert score == 0.0
    assert components["unscoreable"] == "skill 'unknown' declares no evidence_steps"


def test_score_proposal_raises_when_the_classified_skill_was_not_loaded() -> None:
    # The agent proposing under a skill nobody loaded means the trace describes work against
    # instructions that were never in the prompt.
    with pytest.raises(ValueError, match="was not loaded"):
        score_proposal(skills=[{"name": "other"}], class_id="record-match-review", steps=[])


def test_score_proposal_still_raises_on_a_break_type_declaring_no_required_step() -> None:
    """The two zero-denominator cases are different findings and must not be conflated.

    'declares nothing' is the expected shape of the ``unknown`` fallback; 'declares steps but marks
    none required' is a break-type declaration bug Task 4's front-matter lint should have caught.
    """
    skills = [
        {"name": "x", "evidence_steps": [EvidenceStep(id="a", description="a", required=False)]}
    ]
    with pytest.raises(ValueError, match="no required evidence steps"):
        score_proposal(skills=skills, class_id="x", steps=[])


# --- coerce_step_reports: the model's own per-step outcome claims ---------------------------------


def test_step_reports_become_trace_steps() -> None:
    steps = coerce_step_reports(
        raw=[{"step_id": "a", "satisfied": True}], skill="record-match-review"
    )
    assert (steps[0].step_id, steps[0].satisfied, steps[0].kind) == ("a", True, "evidence_step")


def test_step_reports_tolerate_a_json_string() -> None:
    # The harness does not enforce inline-function argument schemas, and the model has been observed
    # emitting arrays as JSON strings (see _coerce_evidence). Same hazard, same coercion.
    steps = coerce_step_reports(raw='[{"step_id": "a", "satisfied": false}]', skill="s")
    assert steps[0].satisfied is False


def test_a_report_without_a_step_id_is_dropped_with_no_step() -> None:
    # Dropped, not defaulted to some step: guessing which prescribed step an unlabelled report meant
    # would fabricate evidence coverage, which is the one thing this score exists to prevent.
    assert coerce_step_reports(raw=[{"satisfied": True}], skill="s") == []


def test_a_non_boolean_satisfied_is_recorded_as_unattempted() -> None:
    # "yes"/"partial"/1 are all things models emit. None (= not attempted) is the honest reading of
    # an outcome we cannot interpret; True would inflate the score on malformed output.
    reports = coerce_step_reports(raw=[{"step_id": "a", "satisfied": "yes"}], skill="s")
    assert reports[0].satisfied is None


def test_unparseable_step_reports_yield_nothing_rather_than_raising() -> None:
    """Junk scores 0.0 and escalates; raising would lose an otherwise-usable proposal."""
    assert coerce_step_reports(raw="not json at all", skill="s") == []
    assert coerce_step_reports(raw={"step_id": "a"}, skill="s") == []  # object, not a list
    assert coerce_step_reports(raw=None, skill="s") == []
    assert coerce_step_reports(raw=["a string entry"], skill="s") == []


# --- downgrade_unsupported_reports: the report is a claim, the tool calls are what happened -------


def test_a_satisfied_claim_with_no_tool_call_behind_it_is_downgraded() -> None:
    steps = [_step("a", True), _step("b", False)]
    out = downgrade_unsupported_reports(steps=steps, observed_tools=set())
    # Downgraded to None (unattempted), not to False: the agent did not report a failed lookup, it
    # reported a successful one that cannot have happened.
    assert [s.satisfied for s in out] == [None, False]


def test_reports_are_untouched_once_any_tool_returned() -> None:
    # Deliberately coarse — one data-returning call is enough. Mapping individual steps to individual
    # tools would need each skill to declare which tool satisfies which step, which the front matter
    # does not carry.
    steps = [_step("a", True)]
    assert downgrade_unsupported_reports(steps=steps, observed_tools={"search_ledger"}) == steps


def test_the_downgrade_cannot_raise_the_score() -> None:
    prescribed = _prescribed(("a", True), ("b", True))
    steps = downgrade_unsupported_reports(steps=[_step("a", True)], observed_tools=set())
    score, components = evidence_completeness(prescribed=prescribed, steps=steps)
    assert score == 0.0
    assert components["unattempted_step_ids"] == ["a", "b"]


def test_non_evidence_trace_entries_pass_through_the_downgrade() -> None:
    """A tool_call step carries satisfied=None already; the rewrite must not disturb its identity."""
    tool_step = ReasoningStep(skill="s", reasoning="called", kind="tool_call")
    out = downgrade_unsupported_reports(steps=[tool_step, _step("a", True)], observed_tools=set())
    assert out[0] is tool_step
