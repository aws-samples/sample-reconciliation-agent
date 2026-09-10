"""Tests for the IDP-aware skill files (document-cross-reference + consult-guidance)."""

from pathlib import Path

from gateway_mcp import GATEWAY_TOOL_NAMES
from skills_loader import catalog, load_skills

SKILLS_DIR = Path(__file__).parent.parent.parent / "agent-blueprint/recon-agent/skills"


def test_consult_guidance_present_with_metadata():
    entries = {e["name"]: e for e in catalog(SKILLS_DIR)}
    assert "consult-guidance" in entries
    # The managed bedrock-knowledge-bases connector's operation name, not the retired Lambda target.
    assert entries["consult-guidance"]["tools"] == ["managed-kb___Retrieve"]


def test_doc_cross_reference_reads_the_notice_row_not_the_document_pipeline():
    """The cross-reference path is the notice row, and the skill may name no tool it does not declare.

    The extracted fields the skill needs — the ``inference_result`` and its per-field confidence —
    are embedded on the notice at ingest as ``idp_sections``, and ``search_notices`` does not withhold
    that attribute. So the skill reaches them in one tool call, and there is no second route to the
    same data: the document pipeline has no tool on this gateway at all.

    The last assertion is written against the LIVE tool surface rather than against a literal tool
    name, and that is the point. Re-granting a document-pipeline tool means adding it to
    ``gateway_mcp.GATEWAY_TOOL_NAMES``; this then fails the moment this skill's body mentions it. A
    hardcoded "that one name is absent" check would go stale the next time the tool is renamed, and
    would say nothing about any OTHER undeclared tool the body starts naming.
    """
    skill = load_skills(SKILLS_DIR, names=["document-cross-reference"])[0]
    body = skill["body"]
    declared = skill["tools"]
    assert declared == ["general-ledger___search_ledger", "notices___search_notices"]
    assert "idp_sections" in body  # reads the extracted fields off the notice row

    undeclared = {
        alias
        for alias, qualified in GATEWAY_TOOL_NAMES.items()
        if alias in body and qualified not in declared
    }
    assert not undeclared, f"skill body names tools it does not declare: {undeclared}"
