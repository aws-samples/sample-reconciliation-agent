"""Contract lint over the repo's live skill catalog.

The skills are UI-editable and read from S3 at runtime, so these assertions are the only
deploy-time gate on their shape. A skill that declares a tool the gateway does not expose, or an
evidence step no prompt ever reports, fails QUIETLY at runtime — hence a lint rather than a review
checklist.
"""

import re
from pathlib import Path

import pytest

from backend.recon_core.skill_meta import parse_skill

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "agent-blueprint" / "recon-agent" / "skills"

# Tiers that investigate and therefore must declare how their answer is judged. Probe/resolution/
# fallback skills are steps within an investigation, not investigations, so they declare neither.
SCORED_TIERS = frozenset({"break-type"})


ALIAS_TABLE_SKILLS = ("record-match-review.md", "ledger-status-resolution.md")
ALIAS_TABLE_START = "<!-- fund-alias-table:start -->"
ALIAS_TABLE_END = "<!-- fund-alias-table:end -->"


def _skills() -> list[dict]:
    """Parse every skill in the repo catalog.

    :returns: parsed skill records, one per ``*.md`` in the skills directory.
    """
    return [parse_skill(p.read_text()) for p in sorted(SKILLS_DIR.glob("*.md"))]


@pytest.mark.parametrize("skill", _skills(), ids=lambda s: s["name"])
def test_break_type_skills_declare_evidence_steps_and_result(skill: dict) -> None:
    """Every investigating skill must state what evidence it wants and how many answers it returns."""
    if skill["metadata"].get("tier") not in SCORED_TIERS:
        return
    assert skill["evidence_steps"], f"{skill['name']} declares no evidence_steps"
    assert skill["result"] is not None, f"{skill['name']} declares no result cardinality"


@pytest.mark.parametrize("skill", _skills(), ids=lambda s: s["name"])
def test_at_least_one_required_step(skill: dict) -> None:
    """A prescribed set with nothing required would divide by zero, or score everything perfect."""
    if not skill["evidence_steps"]:
        return
    assert any(s.required for s in skill["evidence_steps"]), (
        f"{skill['name']} has evidence_steps but none required — the completeness "
        "denominator would be zero and every proposal would score 1.0"
    )


@pytest.mark.parametrize("skill", _skills(), ids=lambda s: s["name"])
def test_no_customer_or_vendor_system_names(skill: dict) -> None:
    """Systems are named by generic role; this repo publishes publicly."""
    # Systems are named by generic role, never by vendor or product. This list is the scrub, not a
    # style preference: the corpus is published, and a named system dates it and implies an
    # endorsement neither the sample nor its reader intends.
    banned = ("geneva", "duco", "ss&c", "ssnc")
    text = (skill["body"] + skill["description"]).lower()
    for term in banned:
        assert term not in text, f"{skill['name']} names a vendor/customer system: {term!r}"


# --- what the closing paragraph asks the model for -----------------------------------------------


@pytest.mark.parametrize("skill", _skills(), ids=lambda s: s["name"])
def test_no_skill_asks_the_model_for_a_confidence_score(skill: dict) -> None:
    """Nothing reads a self-assessed number, so no skill may ask the model for one.

    The score is computed from prescribed-step outcomes. A skill that asks for a
    self-assessed number trains the model to produce a figure nothing reads, in place of the per-step
    report that is the only input to the auto-resolve gate.

    :param skill: one parsed skill record.
    :returns: None.
    """
    body = skill["body"].lower()
    assert "confidence** score in [0,1]" not in body
    assert "confidence score in [0,1]" not in body


@pytest.mark.parametrize("skill", _skills(), ids=lambda s: s["name"])
def test_every_skill_asks_for_per_step_outcomes(skill: dict) -> None:
    """Every closing paragraph must name the field that actually drives the gate.

    Including ``unknown``, which prescribes no steps: it says so explicitly, because a model that
    finds no instruction about ``evidence_steps`` is as likely to invent entries as to omit them.

    :param skill: one parsed skill record.
    :returns: None.
    """
    assert "evidence_steps" in skill["body"]


# --- the duplicated fund alias table --------------------------------------------------------------
# Skills are self-contained markdown loaded independently from S3; there is no include mechanism, so
# the table is duplicated on purpose and this lint is what keeps the copies honest.


def _alias_table(text: str) -> str:
    """Extract the delimited fund alias table from a skill body.

    :param text: the full markdown text of a skill file.
    :returns: the table text between the start and end markers, stripped.
    :raises AssertionError: when either marker is missing — a silently absent table would make the
        byte-identity check pass vacuously for both files.
    """
    assert ALIAS_TABLE_START in text and ALIAS_TABLE_END in text, "alias table markers missing"
    return text.split(ALIAS_TABLE_START)[1].split(ALIAS_TABLE_END)[0].strip()


def test_fund_alias_table_is_byte_identical_across_skills() -> None:
    """Two copies of one table must not drift; a divergent alias resolves differently per skill."""
    tables = [_alias_table((SKILLS_DIR / name).read_text()) for name in ALIAS_TABLE_SKILLS]
    assert tables[0] == tables[1], "the two fund alias tables have drifted apart"


# The auto-resolve floor as SHIPPED, read from the Terraform default rather than hard-coded here. The
# number is Config-tab editable at runtime, so this file cannot know the live value — what it can pin is
# that the value the repo ships with leaves every skill's sub-perfect score below the floor.
_THRESHOLD_SOURCE = REPO_ROOT / "infra" / "modules" / "foundation" / "main.tf"


def _shipped_threshold() -> float:
    """Read the auto-resolve threshold the foundation module defaults to.

    :returns: the threshold as a float.
    :raises AssertionError: when the default cannot be found — a silently-missing value would make the
        margin test below pass against a threshold of 0.0.
    """
    match = re.search(r'value\s*=\s*"(0\.\d+)"', _THRESHOLD_SOURCE.read_text())
    assert match, f"no auto-resolve threshold default found in {_THRESHOLD_SOURCE}"
    return float(match.group(1))


@pytest.mark.parametrize("skill", _skills(), ids=lambda s: s["name"])
def test_incomplete_evidence_cannot_clear_the_auto_resolve_threshold(skill: dict) -> None:
    """⚠️ THE guard on evidence completeness, and it is arithmetic rather than a rule anyone enforces.

    The score is ``satisfied_required / prescribed_required``, so a skill with N required steps produces
    a highest-sub-perfect score of ``(N-1)/N``. That fraction rises with N: at six required steps it is
    0.833 and cannot clear a 0.85 floor, but at SEVEN it is 0.857 and can — meaning a case that satisfied
    six of seven prescribed steps would auto-resolve on incomplete evidence.

    The failure mode is why this test exists rather than a comment. Adding a seventh required step reads
    as *increasing* rigour: the skill demands more, the diff looks like a tightening, every existing test
    still passes, and the effect is to widen autonomy. Nothing else in the repository connects the two.

    Note what this does NOT claim. The live threshold is editable from the Config tab, so lowering it
    below ``(N-1)/N`` re-opens the same hole from the other direction and no test can prevent that. What
    is pinned here is the shipped default, which is the only value the repository controls.

    :param skill: a parsed skill's front matter.
    """
    required = [step for step in skill["evidence_steps"] if step.required]
    if not required:
        pytest.skip(f"{skill['name']} prescribes no required steps")
    count = len(required)
    sub_perfect = (count - 1) / count
    threshold = _shipped_threshold()
    assert sub_perfect < threshold, (
        f"{skill['name']} declares {count} required evidence steps, so satisfying all but one scores "
        f"{sub_perfect:.3f}, which clears the shipped auto-resolve threshold of {threshold}. A case "
        f"with incomplete evidence would auto-resolve. Keep required steps at six or fewer."
    )
