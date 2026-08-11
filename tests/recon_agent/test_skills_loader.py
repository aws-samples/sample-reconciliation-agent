"""Tests for the SKILL.md progressive-disclosure loader.

The loader is imported top-level (``skills_loader``) exactly as it runs in the deployed agent
container; conftest.py puts the recon-agent directory on sys.path.
"""

from pathlib import Path

from skills_loader import catalog, load_skills

SKILLS_DIR = Path(__file__).parent.parent.parent / "agent-blueprint/recon-agent/skills"


def test_catalog_lists_type_metadata_for_classification():
    entries = {e["name"]: e for e in catalog(SKILLS_DIR)}
    assert "record-match-review" in entries
    e = entries["record-match-review"]
    assert e["description"]
    assert e["tools"] == ["general-ledger___search_ledger"]
    assert "model" in e


def test_load_only_named_skills_returns_full_body():
    loaded = load_skills(SKILLS_DIR, names=["record-match-review"])
    assert loaded[0]["name"] == "record-match-review"
    assert len(loaded[0]["body"]) > 0
