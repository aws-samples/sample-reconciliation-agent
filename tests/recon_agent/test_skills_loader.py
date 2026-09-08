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
    assert e["tools"] == [
        "general-ledger___search_ledger",
        "notices___search_notices",
    ]
    assert "model" in e


def test_load_only_named_skills_returns_full_body():
    loaded = load_skills(SKILLS_DIR, names=["record-match-review"])
    assert loaded[0]["name"] == "record-match-review"
    assert len(loaded[0]["body"]) > 0


def test_catalog_is_json_serialisable_with_the_declared_evidence_steps():
    """The catalog is PUBLISHED as JSON, so a typed value in it fails the deploy, not a request.

    ``infra/modules/recon-agent/buildspec.yml`` runs ``json.dumps(catalog(...))`` and uploads the
    result to the assets bucket, where the config UI and the skills API read it. Once frontmatter
    parsing began validating ``evidence_steps`` into pydantic models, that dump raised
    ``TypeError: Object of type EvidenceStep is not JSON serializable`` and the image build failed —
    with no test covering it, because every in-process consumer either uses attribute access or
    passes ``default=str``. Serialising with ``default=str`` would "fix" the build while publishing
    ``"id='fund_alias_match' description=... required=True"`` as the step, so this asserts the
    STRUCTURE survives, not merely that the call returns.

    :returns: None.
    """
    import json

    entries = {e["name"]: e for e in catalog(SKILLS_DIR)}
    round_tripped = json.loads(json.dumps(entries))
    steps = round_tripped["record-match-review"]["evidence_steps"]
    assert steps, "record-match-review declares evidence steps; the catalog must carry them"
    assert all(isinstance(s, dict) for s in steps)
    assert {"id", "description", "required"} <= set(steps[0])
    # `result` is the other typed block, and an absent one must stay absent rather than become "None".
    assert round_tripped["record-match-review"]["result"] in (None,) or isinstance(
        round_tripped["record-match-review"]["result"], dict
    )
