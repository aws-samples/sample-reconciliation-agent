"""The S3 skill catalog (one parser shared with recon), skill selection, and the prompt fallback.

Frontmatter parsing itself is ``backend.recon_core.skill_meta.parse_skill`` and is covered in
``tests/recon_core/test_skill_meta.py``; the two options this loader passes (``name_fallback``,
``ttl_seconds``) are covered in ``tests/recon_core/test_skill_meta_pipeline_options.py``. The tests
here pin what the parsing agent sees: the record shape, the ordering, the directory-name fallback,
read-fresh semantics, the skip-not-crash rule for a broken file, and the two ways an unquoted
``description`` goes wrong as YAML (a silent `` #`` cut, a rejected indicator) that the README's
authoring rule exists for. The README's own frontmatter template is parsed here too.
"""

import logging
import re

import boto3
import pytest
from moto import mock_aws

from backend.deal_pipeline.skills_loader import list_skills, load_text, select_skills
from tests.deal_pipeline.conftest import REPO_ROOT

BLUEPRINT_SKILLS_DIR = REPO_ROOT / "agent-blueprint" / "deal-pipeline-agent" / "skills"
BLUEPRINT_README = REPO_ROOT / "agent-blueprint" / "deal-pipeline-agent" / "README.md"

# Block-style ``metadata``: the form the seed skills do NOT use, so the parser must read both.
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
    # The block form is real YAML and reads like the flow form; recon's parser sees both.
    assert skills[0]["metadata"] == {"tier": "primary"}
    assert "Term loans" in skills[0]["body"]
    assert set(skills[0]) == {"name", "description", "metadata", "body"}
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


def test_list_skills_sees_a_skills_tab_edit_on_the_very_next_call(s3):
    """An approved skill change must apply to the next email: no 60 s cache on the pipeline path.

    Recon's ``read_s3_skills`` caches per process; the pipeline passes ``ttl_seconds=0`` so a warm
    Lambda re-reads S3 every parse. If this fails, an approved proposal looks ignored for a minute.
    """
    s3.put_object(Bucket="assets", Key="skills/deal-parsing/SKILL.md", Body=SKILL_MD.encode())
    assert [s["name"] for s in list_skills(s3, "assets", "skills/")] == ["deal-parsing"]

    s3.put_object(
        Bucket="assets",
        Key="skills/deal-parsing/SKILL.md",
        Body=SKILL_MD.replace("tier: primary", "tier: core").encode(),
    )
    s3.put_object(Bucket="assets", Key="skills/late/SKILL.md", Body=b"---\nname: late\n---\nNew.\n")

    skills = list_skills(s3, "assets", "skills/")
    assert [s["name"] for s in skills] == ["deal-parsing", "late"]
    assert skills[0]["metadata"] == {"tier": "core"}
    assert skills[1]["body"] == "New."


def test_list_skills_skips_and_logs_a_skill_whose_frontmatter_is_not_yaml(s3, caplog):
    """One broken file must not stop every parse; the remaining skills still reach the model.

    The parser this module used to carry handed a file with an unterminated fence to the model as
    body text. The shared parser rejects it as YAML, so it is now logged with its key and left out.
    """
    s3.put_object(Bucket="assets", Key="skills/deal-parsing/SKILL.md", Body=SKILL_MD.encode())
    s3.put_object(
        Bucket="assets", Key="skills/broken/SKILL.md", Body=b"---\nname: broken\nno closing fence\n"
    )

    with caplog.at_level(logging.ERROR, logger="backend.recon_core.skill_meta"):
        skills = list_skills(s3, "assets", "skills/")

    assert [s["name"] for s in skills] == ["deal-parsing"]
    assert "skills/broken/SKILL.md" in caplog.text


def test_list_skills_reads_the_readme_frontmatter_template_with_its_metadata(s3):
    """The template the README tells authors to copy must survive the parser the README documents.

    An earlier draft of that template put ``"---"`` inside ``description``; ``parse_skill`` cuts the
    block at the first ``---`` wherever it sits, so the file lost its ``metadata`` (and with it the
    ``core`` tier) with nothing logged. The first ```yaml block under "Skill frontmatter" is the
    template; whatever it says, it has to round-trip with its ``metadata`` intact.
    """
    match = re.search(r"```yaml\n(---\n.*?\n---)\n```", BLUEPRINT_README.read_text(), re.DOTALL)
    assert match, "README has no ```yaml frontmatter template"
    s3.put_object(
        Bucket="assets",
        Key="skills/deal-parsing/SKILL.md",
        Body=f"{match.group(1)}\n\n# Deal parsing\n\nBody.\n".encode(),
    )
    (skill,) = list_skills(s3, "assets", "skills/")
    assert skill["name"] == "deal-parsing"
    assert skill["description"]
    assert skill["metadata"] == {"tier": "core", "applies_to": ["news-alert", "bank-notice"]}
    assert skill["body"] == "# Deal parsing\n\nBody."


def test_list_skills_cuts_an_unquoted_description_at_a_space_hash_with_nothing_logged(s3, caplog):
    """Pinned flip: ``rated BB #1 pick`` used to load verbatim; YAML reads `` #`` as a comment.

    The cut is silent -- the file is valid YAML -- so nothing reaches CloudWatch. That is why the
    README tells authors to double-quote a description with a ``#`` (or a colon) in it; the quoted
    skill beside it is that remedy, read back verbatim.
    """
    s3.put_object(
        Bucket="assets",
        Key="skills/bare/SKILL.md",
        Body=b"---\nname: bare\ndescription: rated BB #1 pick\n---\nbody\n",
    )
    s3.put_object(
        Bucket="assets",
        Key="skills/quoted/SKILL.md",
        Body=b'---\nname: quoted\ndescription: "rated BB #1 pick: see *notes*"\n---\nbody\n',
    )

    with caplog.at_level(logging.ERROR, logger="backend.recon_core.skill_meta"):
        by_name = {s["name"]: s["description"] for s in list_skills(s3, "assets", "skills/")}

    assert by_name == {"bare": "rated BB", "quoted": "rated BB #1 pick: see *notes*"}
    assert "skipping" not in caplog.text


@pytest.mark.parametrize(
    "description",
    [
        "*bold* start",  # a leading `*` is a YAML alias
        "Read this: carefully",  # `: ` mid-value opens a second mapping
    ],
)
def test_list_skills_skips_and_logs_an_unquoted_description_that_is_not_yaml(
    s3, caplog, description
):
    """Pinned flip: the hand parser loaded these lines verbatim; as YAML they do not parse.

    The skip is loud (the key is logged at ERROR) and local (the other skill still loads). The
    README's rule -- double-quote a description that starts with punctuation or contains ``: `` --
    is what makes such a file load again.
    """
    s3.put_object(Bucket="assets", Key="skills/deal-parsing/SKILL.md", Body=SKILL_MD.encode())
    s3.put_object(
        Bucket="assets",
        Key="skills/odd/SKILL.md",
        Body=f"---\nname: odd\ndescription: {description}\n---\nbody\n".encode(),
    )

    with caplog.at_level(logging.ERROR, logger="backend.recon_core.skill_meta"):
        skills = list_skills(s3, "assets", "skills/")

    assert [s["name"] for s in skills] == ["deal-parsing"]
    assert "skipping unparseable skill s3://assets/skills/odd/SKILL.md" in caplog.text


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
