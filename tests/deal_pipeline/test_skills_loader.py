"""Frontmatter parsing without YAML, the S3 skill catalog, skill selection, and the prompt fallback."""

import boto3
import pytest
from moto import mock_aws

from backend.deal_pipeline.skills_loader import (
    list_skills,
    load_text,
    parse_frontmatter,
    select_skills,
)
from tests.deal_pipeline.conftest import REPO_ROOT

BLUEPRINT_SKILLS_DIR = REPO_ROOT / "agent-blueprint" / "deal-pipeline-agent" / "skills"

SKILL_MD = """---
name: deal-parsing
description: "Parse a new-issue deal email into the OMS staging record."
metadata:
  tier: primary
# a comment line
---

# Deal parsing

Term loans are **Loan**; notes are **Bond**.
"""


def test_parse_frontmatter_reads_flat_keys_and_skips_nested_blocks():
    meta, body = parse_frontmatter(SKILL_MD)
    assert meta == {
        "name": "deal-parsing",
        "description": "Parse a new-issue deal email into the OMS staging record.",
    }
    assert body.startswith("# Deal parsing")
    assert body.endswith("notes are **Bond**.")


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            'metadata: { tier: "format", applies_to: ["bank-notice"] }',
            {"tier": "format", "applies_to": ["bank-notice"]},
        ),
        (
            'metadata: { tier: "core", applies_to: ["news-alert", "bank-notice"] }',
            {"tier": "core", "applies_to": ["news-alert", "bank-notice"]},
        ),
        (
            "metadata: {tier: reference, applies_to: [news-alert,bank-notice]}",
            {
                "tier": "reference",
                "applies_to": ["news-alert", "bank-notice"],
            },
        ),
        ("metadata: { tier: 'core', applies_to: [] }", {"tier": "core", "applies_to": []}),
        ('metadata: { note: "a, b: c", tier: "core" }', {"note": "a, b: c", "tier": "core"}),
        ("metadata: {}", {}),
    ],
)
def test_parse_frontmatter_reads_the_one_line_metadata_flow_mapping(line, expected):
    meta, body = parse_frontmatter(f"---\nname: x\n{line}\n---\nbody\n")
    assert meta == {"name": "x", "metadata": expected}
    assert body == "body"


def test_parse_frontmatter_without_fence_is_all_body():
    assert parse_frontmatter("just prose\n") == ({}, "just prose")


def test_parse_frontmatter_unterminated_fence_keeps_the_text_as_body():
    meta, body = parse_frontmatter("---\nname: x\nno closing fence\n")
    assert meta == {}
    assert "no closing fence" in body


@pytest.fixture
def s3(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="assets")
        yield client


def test_list_skills_reads_every_markdown_file_sorted_with_directory_name_fallback(s3):
    s3.put_object(Bucket="assets", Key="skills/deal-parsing/SKILL.md", Body=SKILL_MD.encode())
    s3.put_object(Bucket="assets", Key="skills/zz-ratings/SKILL.md", Body=b"No frontmatter here.")
    s3.put_object(Bucket="assets", Key="skills/README.txt", Body=b"not a skill")
    skills = list_skills(s3, "assets", "skills/")
    assert [s["name"] for s in skills] == ["deal-parsing", "zz-ratings"]
    assert skills[0]["description"].startswith("Parse a new-issue")
    assert skills[0]["metadata"] == {}  # the nested block form is skipped, not misread
    assert "Term loans" in skills[0]["body"]
    assert skills[1] == {
        "name": "zz-ratings",
        "description": "",
        "metadata": {},
        "body": "No frontmatter here.",
    }


def test_list_skills_reads_the_seeded_blueprint_metadata(s3):
    """The skills Terraform seeds carry the tier/applies_to the parser filters on."""
    for path in sorted(BLUEPRINT_SKILLS_DIR.glob("*/SKILL.md")):
        s3.put_object(
            Bucket="assets", Key=f"skills/{path.parent.name}/SKILL.md", Body=path.read_bytes()
        )
    by_name = {s["name"]: s["metadata"] for s in list_skills(s3, "assets", "skills/")}
    assert by_name["deal-parsing"]["tier"] == "core"
    assert by_name["oms-csv-format"]["tier"] == "reference"
    assert by_name["news-alert-format"] == {"tier": "format", "applies_to": ["news-alert"]}
    assert by_name["bank-notice-format"] == {"tier": "format", "applies_to": ["bank-notice"]}


def test_list_skills_empty_prefix(s3):
    assert list_skills(s3, "assets", "skills/") == []


def test_load_text_returns_object_or_default(s3):
    assert load_text(s3, "assets", "prompts/parser-system.md", "fallback") == "fallback"
    s3.put_object(Bucket="assets", Key="prompts/parser-system.md", Body="seeded prompt".encode())
    assert load_text(s3, "assets", "prompts/parser-system.md", "fallback") == "seeded prompt"


CATALOG = [
    {"name": "bank-notice-format", "metadata": {"tier": "format", "applies_to": ["bank-notice"]}},
    {
        "name": "deal-parsing",
        "metadata": {"tier": "core", "applies_to": ["news-alert", "bank-notice"]},
    },
    {"name": "hand-written", "metadata": {}},  # no frontmatter metadata at all
    {"name": "news-alert-format", "metadata": {"tier": "format", "applies_to": ["news-alert"]}},
    {"name": "oms-csv-format", "metadata": {"tier": "reference", "applies_to": ["news-alert"]}},
    {"name": "untargeted-format", "metadata": {"tier": "format"}},  # format tier, no applies_to
]


@pytest.mark.parametrize(
    ("source_kind", "expected"),
    [
        (
            "bank-notice",
            [
                "bank-notice-format",
                "deal-parsing",
                "hand-written",
                "oms-csv-format",
                "untargeted-format",
            ],
        ),
        (
            "news-alert",
            [
                "deal-parsing",
                "hand-written",
                "news-alert-format",
                "oms-csv-format",
                "untargeted-format",
            ],
        ),
        ("manual", [s["name"] for s in CATALOG]),
        (None, [s["name"] for s in CATALOG]),
        ("", [s["name"] for s in CATALOG]),
        # An unknown kind still gets every non-format skill.
        ("fax", ["deal-parsing", "hand-written", "oms-csv-format", "untargeted-format"]),
    ],
)
def test_select_skills_filters_only_targeted_format_skills(source_kind, expected):
    assert [s["name"] for s in select_skills(CATALOG, source_kind)] == expected
    assert [s["name"] for s in select_skills([], source_kind)] == []
