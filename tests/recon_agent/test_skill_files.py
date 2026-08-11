"""Tests that all classification-type SKILL.md files are present and valid."""

from pathlib import Path

from skills_loader import catalog

SKILLS_DIR = Path(__file__).parent.parent.parent / "agent-blueprint/recon-agent/skills"


def test_all_skill_types_present_and_valid():
    entries = {e["name"]: e for e in catalog(SKILLS_DIR)}
    assert set(entries) == {
        "record-match-review",
        "document-cross-reference",
        "correspondence-search",
        "counterparty-contact-draft",
        "consult-guidance",
        "ledger-status-resolution",
        "unknown",
    }
    for name, e in entries.items():
        assert e["description"], f"{name} missing description"
        assert isinstance(e["tools"], list)  # tools frontmatter (may be empty for `unknown`)
        assert "model" in e  # optional per-skill model override (None when unset)
