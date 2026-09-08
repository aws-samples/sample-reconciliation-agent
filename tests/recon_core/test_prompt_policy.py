"""The shared-core prompt carries policy, so it needs the same guarding as code.

``agent-blueprint/recon-agent/system-prompt.md`` is ``CORE_PROMPT_KEY``: it is read from S3 at runtime,
composed for BOTH agent backends, and editable from the console's prompt editor. That combination is why
these tests exist — the confidence-band policy can be weakened from a text box, with no diff, no review
and no deploy. Nothing else in the repository would notice.

The assertions are deliberately about the PRESENCE of specific claims rather than about wording. A test
that pinned exact prose would fail on every legitimate edit and be deleted within a month; these pin the
handful of statements whose removal changes what the agent is allowed to conclude.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPT = REPO_ROOT / "agent-blueprint" / "recon-agent" / "system-prompt.md"
BACKEND = REPO_ROOT / "backend"
SKILLS = REPO_ROOT / "agent-blueprint" / "recon-agent" / "skills"

# The four core dimensions of the band rule. All four must be named, or the agent is being asked to
# assess "the dimensions" without being told what they are.
CORE_DIMENSIONS = ("fund", "date", "amount", "asset identity")


def _prompt() -> str:
    """Return the shared-core prompt's text.

    :returns: the prompt body.
    """
    return PROMPT.read_text()


def test_the_prompt_exists_and_is_not_empty() -> None:
    """Guard everything below: the composer refuses an empty core prompt, and so does this file."""
    assert PROMPT.is_file(), f"{PROMPT} is missing"
    assert _prompt().strip(), "the shared-core prompt is empty"


@pytest.mark.parametrize("dimension", CORE_DIMENSIONS)
def test_the_prompt_names_every_core_dimension(dimension: str) -> None:
    """A band rule that does not enumerate its inputs is not a rule.

    :param dimension: one of the four core dimensions.
    """
    assert dimension.lower() in _prompt().lower(), (
        f"the prompt no longer names the {dimension!r} core dimension"
    )


def test_the_prompt_forbids_treating_three_of_four_as_the_top_band() -> None:
    """The explicit prohibition, which is the one clause most likely to be trimmed as redundant.

    Without it the model has an enumerated four-dimension rule and no statement of what happens when
    three hold — and "three of four is basically all four" is exactly the inference to prevent.
    """
    text = _prompt().lower()
    assert "three of four is medium at most" in text, (
        "the prompt no longer states that three of four dimensions is MEDIUM at most"
    )


def test_the_prompt_states_that_the_top_band_is_unreachable() -> None:
    """Owner decision (design D7): nothing here can produce HIGH, and the prompt must say why.

    This is the statement that stops the reasoning chain "HIGH needs a finalised record → let us add a
    way to mark records finalised → now HIGH is reachable" from being re-derived from first principles.
    """
    text = _prompt()
    assert "HIGH does not exist on this platform" in text, (
        "the prompt no longer states that HIGH is unreachable — see design D7 before removing this"
    )
    assert "never report it" in text.lower()


def test_the_prompt_distinguishes_unavailable_from_wrong() -> None:
    """The distinction decides MEDIUM versus DISQUALIFIED, and it is not intuitive.

    An absent crosswalk and two conflicting identifiers look alike in a trace and mean opposite things:
    one is a limit on what could be proved, the other is proof of a mismatch.
    """
    text = _prompt().lower()
    assert "unavailable is not the same as it being wrong" in text or (
        "unavailable" in text and "not the same as" in text
    ), "the prompt no longer distinguishes an unavailable dimension from a wrong one"


def test_the_prompt_forbids_using_a_facility_total_as_a_fund_amount() -> None:
    """AM1, the amount rule whose violation is invisible: the comparison simply uses a wrong number."""
    text = _prompt().lower()
    assert "facility-wide total" in text and "fund-level amount" in text, (
        "the prompt no longer separates a facility-wide total from a fund-level amount"
    )


def test_the_prompt_does_not_present_the_band_as_permission_to_act() -> None:
    """The band is a report to a human; the server-side checks are what actually gate a write.

    A prompt that conflated them would invite the model to treat its own conclusion as authorisation.
    """
    assert "decides nothing on its own" in _prompt(), (
        "the prompt no longer says the band is advisory rather than authorising"
    )


# --- No code may award the top band ---------------------------------------------------------------

# A band literal in a comparison or an assignment. Deliberately narrow: the word HIGH appears in prose
# for legitimate reasons, and a test that flagged every mention would be turned off.
_HIGH_BAND = re.compile(
    r"""(?:confidence_band|band)\s*(?:=|==|:)\s*['"]HIGH['"]|['"]HIGH['"]\s*(?:==|!=)"""
)

# A validation status DECLARED — a model field, a keyword argument, an assignment — or one of the human
# status values as a literal. Deliberately not a bare substring search: the Notice model's docstring
# explains at length that no such field exists, and a substring ban would flag the very comment that
# records the decision. Documenting a prohibition must not violate it.
_VALIDATION_STATUS = re.compile(
    r"""internal_validation_status\s*[:=]|['"]USER_VALIDATED['"]|['"]USER_CORRECTED['"]"""
)


def _sources() -> list[Path]:
    """Return every backend module and skill file the ban applies to.

    :returns: sorted list of paths.
    """
    return sorted([*BACKEND.rglob("*.py"), *SKILLS.glob("*.md")])


def test_there_are_sources_to_scan() -> None:
    """Guard the scan below against passing on an empty list."""
    assert _sources(), "found no backend modules or skills to scan"


@pytest.mark.parametrize("source", _sources(), ids=lambda path: path.name)
def test_no_source_awards_the_top_band(source: Path) -> None:
    """Nothing computes or assigns HIGH (design D7), and this is the guard that keeps it that way.

    The band is not a stored or computed value at all: it is a conclusion the agent states in prose,
    bounded by the prompt. A constant or comparison appearing here would mean something in code had
    started deciding bands — at which point the prompt's claim that HIGH is unreachable becomes false
    while still reading as true.

    :param source: a backend module or skill file.
    """
    text = source.read_text(encoding="utf-8", errors="replace")
    offenders = _HIGH_BAND.findall(text)
    assert not offenders, (
        f"{source.name} contains a HIGH band literal {offenders!r}; nothing may award HIGH — see D7"
    )


@pytest.mark.parametrize("source", _sources(), ids=lambda path: path.name)
def test_no_source_reintroduces_a_human_validation_status(source: Path) -> None:
    """The other half of D7: no validation status, so no route to a finalised record.

    Kept beside the band ban because the two are one decision. Re-adding either alone makes the other
    incoherent — a validation status with no band to unlock, or a band with no way to earn it.

    :param source: a backend module or skill file.
    """
    text = source.read_text(encoding="utf-8", errors="replace")
    offenders = _VALIDATION_STATUS.findall(text)
    assert not offenders, (
        f"{source.name} declares {offenders!r}; design D7 rules out a notice validation status"
    )


def test_the_prompt_states_that_guidance_is_not_evidence() -> None:
    """The rule the gateway enforces has to be one the agent was told, or it repeats the refusal.

    A gate that refuses without the model understanding why produces the same rejected proposal over and
    over. This pins the statement for the same reason the band rules are pinned: the prompt is editable
    from a text box, so policy can leave it with no diff and no review.
    """
    text = _prompt()
    assert "Guidance is not evidence" in text, (
        "the prompt no longer states that guidance cannot support a resolution"
    )
    assert "playbook" in text.lower() and "method" in text.lower(), (
        "the prompt no longer explains WHY a playbook cannot be evidence"
    )
