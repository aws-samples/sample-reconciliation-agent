"""The two ``read_s3_skills`` options the deal pipeline passes, and the frontmatter style its seeds use.

``backend/deal_pipeline/skills_loader.list_skills`` is the only caller that passes ``name_fallback``
or ``ttl_seconds``. Recon passes neither, so the first group here pins that a call with no options
-- or with both spelled out as None -- reads, drops and caches exactly what it did before the options
existed. The next two groups pin what each option changes and, just as important, what it leaves
alone: a fallback read never serves recon's cached list and a TTL-0 read never overwrites it. The
last group runs the pipeline's seed frontmatter style (a one-line YAML flow mapping under
``metadata``) through ``parse_skill``; the pipeline's own hand parser used to be tested on those
exact lines, and this is where that coverage now lives.
"""

import logging

import boto3
import pytest
from moto import mock_aws

from backend.recon_core import skill_meta
from backend.recon_core.skill_meta import NAME_FALLBACK_DIRECTORY, parse_skill, read_s3_skills

BUCKET = "recon-assets"
LOGGER = "backend.recon_core.skill_meta"

NAMED = (
    '---\nname: deal-parsing\ndescription: Core rules.\nmetadata: { tier: "core" }\n---\nRules.\n'
)
# A file saved straight from an editor with no frontmatter at all -- the case the pipeline promises
# still loads (named after its folder) and recon drops (nothing for the classifier to match on).
NAMELESS = "# Ratings\n\nNo frontmatter here.\n"
LATE = "---\nname: late\n---\nNew.\n"


@pytest.fixture
def s3(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        client.put_object(Bucket=BUCKET, Key="skills/deal-parsing/SKILL.md", Body=NAMED.encode())
        client.put_object(Bucket=BUCKET, Key="skills/zz-ratings/SKILL.md", Body=NAMELESS.encode())
        yield client


def _names(skills: list[dict]) -> list[str]:
    return sorted(s["name"] for s in skills)


# --- defaults: what recon reads is what it read before the options existed -----------------------


def test_no_options_drops_the_nameless_skill_and_caches_under_the_bare_key_for_sixty_seconds(
    s3, caplog
):
    """Recon's contract, pinned before anything about the options: nameless dropped, 60 s cache."""
    with caplog.at_level(logging.ERROR, logger=LOGGER):
        skills = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3)

    assert _names(skills) == ["deal-parsing"]
    assert "skills/zz-ratings/SKILL.md" in caplog.text and "no `name`" in caplog.text
    assert set(skill_meta._S3_CACHE) == {"recon-assets/skills/"}
    expiry, cached = skill_meta._S3_CACHE["recon-assets/skills/"]
    assert expiry == float(skill_meta.S3_TTL_SECONDS)
    assert cached is skills


def test_options_spelled_out_as_none_are_the_no_options_call(s3):
    """``name_fallback=None, ttl_seconds=None`` must be indistinguishable from passing nothing."""
    plain = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3)
    plain_cache = dict(skill_meta._S3_CACHE)
    skill_meta._S3_CACHE.clear()

    explicit = read_s3_skills(
        BUCKET, "skills/", now=lambda: 0.0, s3=s3, name_fallback=None, ttl_seconds=None
    )

    assert explicit == plain
    assert set(skill_meta._S3_CACHE) == set(plain_cache) == {"recon-assets/skills/"}
    assert skill_meta._S3_CACHE["recon-assets/skills/"][0] == plain_cache["recon-assets/skills/"][0]


# --- name_fallback="directory" -------------------------------------------------------------------


def test_directory_fallback_names_a_nameless_skill_after_its_folder_and_keeps_declared_names(
    s3, caplog
):
    """The pipeline's ``skills/<name>/SKILL.md`` layout: the folder is the name when the file has none.

    A declared ``name`` still wins over the folder -- the fallback is a fallback, not a rename.
    """
    s3.put_object(
        Bucket=BUCKET, Key="skills/folder-x/SKILL.md", Body=b"---\nname: declared\n---\nb\n"
    )

    with caplog.at_level(logging.ERROR, logger=LOGGER):
        skills = read_s3_skills(
            BUCKET, "skills/", now=lambda: 0.0, s3=s3, name_fallback=NAME_FALLBACK_DIRECTORY
        )

    assert _names(skills) == ["deal-parsing", "declared", "zz-ratings"]
    ratings = next(s for s in skills if s["name"] == "zz-ratings")
    assert ratings["description"] == "" and ratings["metadata"] == {}
    assert ratings["body"] == "# Ratings\n\nNo frontmatter here."
    assert "skipping" not in caplog.text


def test_directory_fallback_still_drops_a_key_with_no_directory(s3, caplog):
    """An object at the bucket root has no folder to be named after, so it is dropped as before."""
    s3.put_object(Bucket=BUCKET, Key="SKILL.md", Body=NAMELESS.encode())

    with caplog.at_level(logging.ERROR, logger=LOGGER):
        skills = read_s3_skills(
            BUCKET, "", now=lambda: 0.0, s3=s3, name_fallback=NAME_FALLBACK_DIRECTORY
        )

    assert _names(skills) == ["deal-parsing", "zz-ratings"]
    assert f"skipping skill s3://{BUCKET}/SKILL.md" in caplog.text


def test_fallback_and_default_reads_of_one_prefix_cache_separately(s3):
    """The two reads return different lists, so they must never be served from each other's entry."""
    plain = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3)
    fallback = read_s3_skills(
        BUCKET, "skills/", now=lambda: 0.0, s3=s3, name_fallback=NAME_FALLBACK_DIRECTORY
    )
    assert _names(plain) == ["deal-parsing"]
    assert _names(fallback) == ["deal-parsing", "zz-ratings"]
    assert set(skill_meta._S3_CACHE) == {"recon-assets/skills/", "recon-assets/skills/#directory"}

    # Both entries are still warm at t=30; each read must come back from its own.
    assert read_s3_skills(BUCKET, "skills/", now=lambda: 30.0, s3=s3) is plain
    assert (
        read_s3_skills(
            BUCKET, "skills/", now=lambda: 30.0, s3=s3, name_fallback=NAME_FALLBACK_DIRECTORY
        )
        is fallback
    )


def test_unknown_name_fallback_raises_before_touching_s3_or_the_cache(s3):
    """A misspelt option must not quietly degrade to "drop the skill"."""
    with pytest.raises(ValueError, match="name_fallback"):
        read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3, name_fallback="folder")
    assert skill_meta._S3_CACHE == {}


# --- ttl_seconds ---------------------------------------------------------------------------------


def test_ttl_zero_reads_s3_on_every_call_and_leaves_the_cache_alone(s3):
    """The pipeline's read-fresh promise: an edit is visible on the next call, at the same clock.

    Also pins the other half -- a TTL-0 read stores nothing, so it can neither be served from nor
    overwrite the 60 s entry a default read of the same prefix has already stored.
    """
    plain = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3)
    assert _names(plain) == ["deal-parsing"]

    first = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3, ttl_seconds=0)
    s3.put_object(Bucket=BUCKET, Key="skills/late/SKILL.md", Body=LATE.encode())
    second = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3, ttl_seconds=0)

    assert _names(first) == ["deal-parsing"]
    assert _names(second) == ["deal-parsing", "late"]
    assert set(skill_meta._S3_CACHE) == {"recon-assets/skills/"}
    assert skill_meta._S3_CACHE["recon-assets/skills/"][1] is plain
    # The default reader is still on its own 60 s entry, untouched by the fresh reads beside it.
    assert read_s3_skills(BUCKET, "skills/", now=lambda: 30.0, s3=s3) is plain


def test_ttl_zero_with_the_directory_fallback_is_what_the_pipeline_reads(s3):
    """The exact call ``deal_pipeline.skills_loader.list_skills`` makes, end to end."""
    first = read_s3_skills(
        BUCKET,
        "skills/",
        now=lambda: 0.0,
        s3=s3,
        name_fallback=NAME_FALLBACK_DIRECTORY,
        ttl_seconds=0,
    )
    s3.put_object(Bucket=BUCKET, Key="skills/late/SKILL.md", Body=LATE.encode())
    second = read_s3_skills(
        BUCKET,
        "skills/",
        now=lambda: 0.0,
        s3=s3,
        name_fallback=NAME_FALLBACK_DIRECTORY,
        ttl_seconds=0,
    )

    assert _names(first) == ["deal-parsing", "zz-ratings"]
    assert _names(second) == ["deal-parsing", "late", "zz-ratings"]
    assert skill_meta._S3_CACHE == {}


def test_positive_ttl_override_sets_that_expiry(s3):
    """``ttl_seconds=5`` caches for five seconds, not sixty; the entry expires on that clock."""
    first = read_s3_skills(BUCKET, "skills/", now=lambda: 0.0, s3=s3, ttl_seconds=5)
    assert skill_meta._S3_CACHE["recon-assets/skills/"][0] == 5.0

    s3.put_object(Bucket=BUCKET, Key="skills/late/SKILL.md", Body=LATE.encode())
    assert read_s3_skills(BUCKET, "skills/", now=lambda: 4.0, s3=s3, ttl_seconds=5) is first
    refreshed = read_s3_skills(BUCKET, "skills/", now=lambda: 6.0, s3=s3, ttl_seconds=5)
    assert _names(refreshed) == ["deal-parsing", "late"]


# --- the pipeline's seed frontmatter style through the shared parser -----------------------------


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
            {"tier": "reference", "applies_to": ["news-alert", "bank-notice"]},
        ),
        ("metadata: { tier: 'core', applies_to: [] }", {"tier": "core", "applies_to": []}),
        ('metadata: { note: "a, b: c", tier: "core" }', {"note": "a, b: c", "tier": "core"}),
        ("metadata: {}", {}),
    ],
)
def test_parse_skill_reads_the_one_line_metadata_flow_mapping_the_pipeline_seeds_use(
    line, expected
):
    """The deal pipeline's four seed skills write ``metadata`` in YAML flow style on one line.

    These are the cases the pipeline's deleted hand parser was tested on; ``select_skills`` filters on
    ``metadata.tier`` and ``metadata.applies_to``, so the shared parser has to read them identically.
    """
    skill = parse_skill(f"---\nname: x\n{line}\n---\nbody\n")
    assert skill["name"] == "x"
    assert skill["metadata"] == expected
    assert skill["body"] == "body"


def test_parse_skill_rejects_an_unterminated_fence_instead_of_treating_the_file_as_body():
    """Pinned flip: the pipeline's hand parser handed this whole file to the model as body text.

    With one parser for both apps the remainder is read as frontmatter, fails as YAML and raises;
    on the S3 path ``_parse_s3_skill`` logs that and skips the file, and the other skills still load.
    """
    with pytest.raises(ValueError, match="frontmatter"):
        parse_skill("---\nname: x\nno closing fence\n")
