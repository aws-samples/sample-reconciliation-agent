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


def test_every_skill_declares_a_known_tier():
    """The taxonomy must be explicit, because `tier` is what tells a reader whether a skill is a
    classification the agent picks or a procedure it invokes along the way."""
    for e in catalog(SKILLS_DIR):
        assert isinstance(e["metadata"], dict), f"{e['name']} metadata must be a mapping"
        tier = e["metadata"].get("tier")
        assert tier in {"break-type", "probe", "resolution", "fallback"}, f"{e['name']}: {tier}"


def test_every_tier1_class_exists_in_the_catalog():
    """The one build-time check behind Tier-1's rule table.

    ``BREAK_TYPE_RULES`` names classes as bare strings; nothing at runtime resolves them, because
    the stream consumer deliberately cannot read the catalog. Rename or delete a skill and Tier-1 goes
    on stamping a `tier1_break_type` that both Tier-2 backends silently drop as unknown
    (``_class_hint_block`` / ``_class_hint_line``) — a hint that vanishes with no error anywhere. This
    test is the only thing that turns that into a failure.
    """
    from backend.tier1.classify import BREAK_TYPE_RULES

    shipped = {e["name"] for e in catalog(SKILLS_DIR)}
    assert BREAK_TYPE_RULES, "an empty rule table would make this whole check vacuous"
    for name, _predicate in BREAK_TYPE_RULES:
        assert name in shipped, f"Tier-1 rule names {name!r}, which is not a shipped skill"
