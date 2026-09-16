"""Contract lint over the shared base system prompt.

The prompt is the only place the model can learn what the platform actually measures, and
``config_store.build`` prepends this one file on BOTH backends — so a stale sentence here misdirects
every investigation on both paths at once. It is also UI-editable and read from S3 at runtime, which
makes a deploy-time lint the only gate on its content.
"""

from pathlib import Path

import pytest

_BLUEPRINTS = Path(__file__).resolve().parents[2] / "agent-blueprint"
_CORE_PROMPT_PATH = _BLUEPRINTS / "recon-agent" / "system-prompt.md"
_HARNESS_PROMPT_PATH = _BLUEPRINTS / "recon-agent-harness" / "system-prompt.md"
_PROMPT = _CORE_PROMPT_PATH.read_text()

# Both halves are deployed to S3 and read at invoke time, so each needs the same lint. The core file
# is the shared policy; the harness file is the calling contract composed onto it.
_PROMPT_PATHS = [_CORE_PROMPT_PATH, _HARNESS_PROMPT_PATH]


def test_prompt_does_not_promise_a_composite_score() -> None:
    """No sentence may still describe the deleted weighted composite.

    Leaving them tells the model its self-assessed number is load-bearing, so it optimises that
    instead of reporting step outcomes — the one input the auto-resolve gate reads.

    :returns: None.
    """
    for stale in (
        "self-consistency across samples",
        # Deliberately the bare phrase, not the target-prefixed spelling the prompt once used: it is a
        # substring of that spelling, so this catches the original wording AND any respelling of the
        # same retired composite input.
        "extraction alerts",
        "Your confidence therefore carries weight",
    ):
        assert stale not in _PROMPT, f"prompt still describes the deleted composite: {stale!r}"


def test_prompt_states_the_evidence_step_contract() -> None:
    """The prompt must name the reported field and the fact that only required steps count.

    :returns: None.
    """
    assert "evidence_steps" in _PROMPT
    assert "required" in _PROMPT


@pytest.mark.parametrize("path", _PROMPT_PATHS, ids=lambda p: p.parent.name)
def test_no_prompt_asks_the_model_to_grade_itself(path: Path) -> None:
    """The model reports EVIDENCE; the platform computes the confidence from it.

    Both prompts are UI-editable S3 objects read at invoke time, so a stale instruction here outlives
    every code change — no such field exists in the submit schema, but a prompt that asks for a number
    gets one, and the next reader wires it back up. The same goes for a 0.6 confidence cliff: no code
    implements one, and a prompt describing a gate that does not exist is worse than one that says
    nothing.

    :param path: the prompt file to lint.
    :returns: None.
    """
    text = path.read_text()
    for stale in (
        "confidence in [0,1]",
        "classification_confidence",
        "verbalized_confidence",
        "below 0.6",
    ):
        assert stale not in text, f"{path.name} still asks the model to grade itself: {stale!r}"


@pytest.mark.parametrize("path", _PROMPT_PATHS, ids=lambda p: p.parent.name)
def test_both_prompts_still_demand_evidence_steps(path: Path) -> None:
    """The one self-report that IS scored must not be collateral damage of the removal above.

    :param path: the prompt file to lint.
    :returns: None.
    """
    assert "evidence_steps" in path.read_text()
