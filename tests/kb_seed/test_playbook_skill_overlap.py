"""Playbooks may not point the agent at things the skills do not have.

A retrieved playbook and an always-present skill are two voices telling the agent what to do, and when
they disagree the failure is silent: the skill wins in practice, while the playbook can still be quoted
back into the analyst-facing trace. So the corpus and the catalog have to stay reconcilable.

Semantic duplication cannot be linted — no test can tell that a paragraph restates a procedure. What CAN
be linted is a playbook referring to something that does not exist, and that turns out to be where the
real drift showed up: ``autonomy-and-escalation.md`` spent months directing readers to "see each
SKILL.md ``confidence_threshold``", a front-matter key no skill has ever declared. The instruction was
unfollowable and nothing reported it. These tests are the cheap half of the audit, kept because the
expensive half (reading for overlap) cannot be automated and therefore will not be repeated.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLAYBOOKS = REPO_ROOT / "data" / "kb-seed" / "playbooks"
SKILLS_DIR = REPO_ROOT / "agent-blueprint" / "recon-agent" / "skills"

# Keys a playbook might plausibly send a reader to look up in a skill's front matter. Each is checked
# only when a playbook actually mentions it, so this list is a vocabulary rather than a requirement.
FRONT_MATTER_KEYS = (
    "confidence_threshold",
    "autonomy",
    "tier",
    "evidence_steps",
    "cardinality",
    "max_candidates",
    "tools",
)

# Statements a playbook must not make, because a skill or the prompt now owns them and a second copy can
# only drift. Matched as whole words to avoid flagging prose that merely discusses the topic.
FORBIDDEN_CLAIMS = {
    # `record-match-review` is propose-only; a playbook saying "auto-match" contradicts its front matter.
    r"\bauto-match\b": "autonomy is decided by the skill's front matter and the server-side gates",
    # The band ladder lives in the shared-core prompt, once.
    r"\bHIGH confidence\b": "the confidence bands are stated in the shared-core system prompt",
}


def _playbooks() -> list[Path]:
    """Return every playbook document (not its sidecar).

    :returns: sorted list of paths.
    """
    return sorted(p for p in PLAYBOOKS.glob("*.md") if not p.name.endswith(".metadata.json"))


def _declared_front_matter_keys() -> set[str]:
    """Collect every top-level front-matter key any skill declares.

    Read from the raw text rather than through the parser, because the question is what a READER of a
    skill file would find when following a playbook's instruction — including keys nested under
    ``metadata:``, which a reader would not distinguish.

    :returns: the set of key names appearing in any skill's front matter.
    """
    keys: set[str] = set()
    for path in SKILLS_DIR.glob("*.md"):
        text = path.read_text()
        if not text.startswith("---"):
            continue
        front_matter = text.split("---", 2)[1]
        keys.update(re.findall(r"^\s*([a-z_]+):", front_matter, flags=re.MULTILINE))
    return keys


PLAYBOOK_FILES = _playbooks()


def test_there_are_playbooks_to_check() -> None:
    """Guard the parametrised tests below against passing vacuously on an empty corpus."""
    assert PLAYBOOK_FILES, f"no playbooks found under {PLAYBOOKS}"


@pytest.mark.parametrize("playbook", PLAYBOOK_FILES, ids=lambda p: p.name)
def test_no_playbook_cites_a_front_matter_key_no_skill_declares(playbook: Path) -> None:
    """An instruction to consult a key that does not exist cannot be followed, and nothing errors.

    :param playbook: the playbook document.
    """
    text = playbook.read_text()
    declared = _declared_front_matter_keys()
    dangling = sorted(key for key in FRONT_MATTER_KEYS if key in text and key not in declared)
    assert not dangling, (
        f"{playbook.name} sends the reader to skill front-matter key(s) {dangling}, which no skill "
        f"declares. Declared keys are {sorted(declared)}"
    )


@pytest.mark.parametrize("playbook", PLAYBOOK_FILES, ids=lambda p: p.name)
def test_no_playbook_restates_a_claim_a_skill_owns(playbook: Path) -> None:
    """Where two surfaces state one rule, the retrieved one is the copy that goes stale unnoticed.

    :param playbook: the playbook document.
    """
    text = playbook.read_text()
    for pattern, owner in FORBIDDEN_CLAIMS.items():
        assert not re.search(pattern, text, flags=re.IGNORECASE), (
            f"{playbook.name} states {pattern!r}, but {owner}"
        )


def test_the_retired_escalation_playbook_is_gone() -> None:
    """Its content is in the prompt now, and re-adding the file would restore the contradiction.

    Named explicitly rather than left implicit: a policy document that can only be reached by retrieval
    is absent from exactly the narrowed searches that need it most, which is the argument for moving it
    and the reason not to move it back.
    """
    retired = PLAYBOOKS / "autonomy-and-escalation.md"
    assert not retired.exists(), (
        "autonomy-and-escalation.md is back. Escalation policy belongs in the shared-core system "
        "prompt, which is always present, not in a corpus reached by a filtered search."
    )
    assert not (PLAYBOOKS / "autonomy-and-escalation.md.metadata.json").exists(), (
        "an orphaned sidecar for the retired playbook remains"
    )
