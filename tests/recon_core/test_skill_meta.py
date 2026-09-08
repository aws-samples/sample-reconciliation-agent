"""Tests for the shared SKILL.md frontmatter parser."""

import pytest

from backend.recon_core.skill_meta import catalog_entry, evidence_step_block, parse_skill

MD = """---
name: demo-skill
description: A demo.
tools: [general-ledger___search_ledger, managed-kb___Retrieve]
metadata:
  tier: break-type
  autonomy: propose-only
---

Body text here.
"""


def test_parses_flat_and_nested_frontmatter():
    s = parse_skill(MD)
    assert s["name"] == "demo-skill"
    assert s["tools"] == [
        "general-ledger___search_ledger",
        "managed-kb___Retrieve",
    ]
    assert s["metadata"] == {"tier": "break-type", "autonomy": "propose-only"}
    assert s["body"] == "Body text here."


def test_no_frontmatter_yields_empty_metadata_and_full_body():
    s = parse_skill("Just a body.")
    assert s["name"] == "" and s["metadata"] == {} and s["body"] == "Just a body."


def test_malformed_yaml_raises():
    with pytest.raises(ValueError, match="frontmatter"):
        parse_skill("---\nname: x\n  bad: : :\n---\nbody\n")


def test_bare_comma_tools_parse():
    """A SKILL.md may write `tools: a, b` rather than a YAML list."""
    s = parse_skill("---\nname: x\ntools: alpha, beta\n---\nbody\n")
    assert s["tools"] == ["alpha", "beta"]


def test_non_mapping_frontmatter_raises():
    """A YAML list where a mapping is expected must fail loudly, not silently yield no metadata."""
    with pytest.raises(ValueError, match="mapping"):
        parse_skill("---\n- a\n- b\n---\nbody\n")


def test_non_mapping_metadata_raises():
    with pytest.raises(ValueError, match="metadata"):
        parse_skill("---\nname: x\nmetadata: just-a-string\n---\nbody\n")


def test_python_object_tag_is_not_constructed():
    """safe_load, never load: skill files are UI-editable and read live from S3.

    A `!!python/object/apply` tag is the classic YAML deserialisation RCE. safe_load refuses to
    construct it, which surfaces here as a ValueError from the frontmatter guard rather than as
    arbitrary code running with the Lambda role's credentials.
    """
    hostile = "---\nname: x\nmetadata: !!python/object/apply:os.system ['echo pwned']\n---\nb\n"
    with pytest.raises(ValueError, match="frontmatter"):
        parse_skill(hostile)


def test_quoted_value_containing_a_triple_dash_fails_loudly():
    """KNOWN LIMITATION, pinned deliberately rather than left to surprise someone.

    The split is ``md[3:].partition("---")``, which finds the FIRST ``---`` anywhere in the text —
    including inside a value. A *quoted* value is cut mid-string, leaving an unterminated scalar, so
    YAML refuses it and the skill is rejected. Loud, which is the good case.
    """
    with pytest.raises(ValueError, match="frontmatter"):
        parse_skill('---\nname: x\ndescription: "a --- b"\n---\nbody\n')


def test_unquoted_value_containing_a_triple_dash_truncates_silently():
    """The bad half of the same limitation: an UNQUOTED value truncates with no error at all.

    ``description: a --- b`` parses as ``description: a`` and ``" b"`` leaks into the body. Nothing
    raises, so the only signal is a skill whose description is mysteriously short. Pinned so a
    future fix (a line-anchored ``\\n---`` split) has a starting point, and so nobody changes the
    behaviour by accident and wonders what broke.
    """
    s = parse_skill("---\nname: x\ndescription: a --- b\n---\nbody\n")
    assert s["name"] == "x"
    assert s["description"] == "a"
    assert s["body"].endswith("body")


# --- evidence_steps and result --------------------------------------------------------------------


def test_parse_skill_surfaces_evidence_steps_and_result() -> None:
    """Both new blocks must reach the caller typed, in file order, with `required` preserved."""
    md = (
        "---\n"
        "name: record-match-review\n"
        "result:\n"
        "  cardinality: ranked_set\n"
        "  max_candidates: 5\n"
        "evidence_steps:\n"
        "  - id: fund_alias_match\n"
        "    required: true\n"
        "    description: Resolve the fund label.\n"
        "  - id: notice_corroboration\n"
        "    required: false\n"
        "    description: Corroborate against a notice.\n"
        "---\n"
        "body text\n"
    )
    skill = parse_skill(md)
    assert [s.id for s in skill["evidence_steps"]] == [
        "fund_alias_match",
        "notice_corroboration",
    ]
    assert skill["evidence_steps"][1].required is False
    assert skill["result"].cardinality == "ranked_set"


def test_parse_skill_defaults_when_keys_absent() -> None:
    """A skill declaring neither block makes no cardinality claim and prescribes no steps."""
    skill = parse_skill("---\nname: unknown\n---\nbody\n")
    assert skill["evidence_steps"] == []
    assert skill["result"] is None


def test_parse_skill_raises_on_malformed_evidence_step() -> None:
    """A step missing its id fails loudly — it would otherwise skew the score's denominator."""
    md = "---\nname: x\nevidence_steps:\n  - description: no id here\n---\nb\n"
    with pytest.raises(ValueError, match="evidence_steps"):
        parse_skill(md)


# --- evidence_step_block: the ONE renderer both Tier-2 backends prompt from -----------------------


def test_the_block_names_every_declared_id_with_its_required_flag() -> None:
    """The ids are the whole point: without them the model invents plausible ones from the prose.

    Required/optional is asserted too, because only required steps are the score's denominator — an
    agent that cannot tell them apart spends tool calls on steps that cannot raise its score.

    :returns: None.
    """
    skill = parse_skill(
        "---\nname: s\nevidence_steps:\n"
        "  - id: fund_alias_match\n    description: resolve the alias\n    required: true\n"
        "  - id: prior_lesson\n    description: check lessons\n    required: false\n"
        "---\nbody\n"
    )

    block = evidence_step_block(skill)

    assert "fund_alias_match" in block and "(required)" in block
    assert "prior_lesson" in block and "(optional)" in block


def test_a_skill_declaring_no_steps_renders_nothing() -> None:
    """`unknown` prescribes nothing; a bare "report each one by its exact id" heading would read as
    an instruction to report ids that do not exist.

    :returns: None.
    """
    assert evidence_step_block({"name": "unknown", "body": "escalate"}) == ""


def test_model_steps_and_catalog_dicts_render_identically() -> None:
    """The two backends pass different SHAPES of the same declaration; both must render the same.

    The runtime prompts from ``parse_skill`` records (``EvidenceStep`` models); the harness prompts
    from ``catalog_entry`` projections (JSON dicts). If only one shape rendered, the backend passing
    the other would silently prompt with no ids at all — which is the 2026-09-02 harness failure.

    :returns: None.
    """
    skill = parse_skill(
        "---\nname: s\nevidence_steps:\n"
        "  - id: expected_entry_match\n    description: find the entry\n    required: true\n"
        "---\nbody\n"
    )

    assert evidence_step_block(skill) == evidence_step_block(catalog_entry(skill))
    assert "expected_entry_match" in evidence_step_block(catalog_entry(skill))
