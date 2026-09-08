"""Tests for the IDP-aware skill files (document-cross-reference + consult-guidance)."""

from pathlib import Path

from skills_loader import catalog, load_skills

SKILLS_DIR = Path(__file__).parent.parent.parent / "agent-blueprint/recon-agent/skills"


def test_consult_guidance_present_with_metadata():
    entries = {e["name"]: e for e in catalog(SKILLS_DIR)}
    assert "consult-guidance" in entries
    # The managed bedrock-knowledge-bases connector's operation name, not the retired Lambda target.
    assert entries["consult-guidance"]["tools"] == ["managed-kb___Retrieve"]


def test_doc_cross_reference_mentions_idp_backlink_and_mcp():
    body = load_skills(SKILLS_DIR, names=["document-cross-reference"])[0]["body"]
    assert "idp:" in body  # reads the backlink
    assert "document-extraction___IDPTools___get_results" in body  # calls IDP MCP
