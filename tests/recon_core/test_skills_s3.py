"""Tests for the harness backend's S3 skill catalog.

The point of these tests is agreement: ``backend.recon_core.skills_s3.catalog_s3`` (harness backend)
and ``skills_loader.catalog_s3`` (agent container) must read one S3 object into one record, because
``AGENT_BACKEND`` switches between them at runtime and a catalog that differs by backend is a
difference no caller can see.
"""

import logging

import boto3
import pytest
from moto import mock_aws
from skills_loader import catalog_s3 as catalog_s3_runtime

from backend.recon_core import skill_meta
from backend.recon_core.skills_s3 import catalog_s3

SKILL = """---
name: record-match-review
description: Compare the two sides' economic attributes.
tools: [general-ledger___search_ledger]
metadata:
  tier: break-type
  autonomy: propose-only
---

Compare account name, amount and entry type.
"""


def _seed(*, key: str = "skills/record-match-review.md", body: str = SKILL):
    """Create the assets bucket and put one skill object in it.

    :param key: object key to write.
    :param body: SKILL.md text to write.
    :returns: the moto-backed S3 client, for injection into the loader.
    """
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="recon-assets")
    s3.put_object(Bucket="recon-assets", Key=key, Body=body.encode())
    return s3


@mock_aws
def test_catalog_surfaces_the_nested_metadata_block():
    """``metadata`` must survive the parse and reach the harness catalog, ``metadata.tier`` included.

    This is what a flat-keys-only parser silently drops: the nested block simply never appears, and the
    harness then disagrees with the runtime about what a skill declares.
    """
    s3 = _seed()
    cat = catalog_s3("recon-assets", "skills/", now=lambda: 0.0, s3=s3)
    assert cat[0]["metadata"] == {"tier": "break-type", "autonomy": "propose-only"}
    assert cat[0]["tools"] == ["general-ledger___search_ledger"]
    assert "body" not in cat[0]  # L1 catalog: metadata only


@mock_aws
def test_both_tier2_backends_read_an_identical_catalog():
    s3 = _seed()
    harness = catalog_s3("recon-assets", "skills/", now=lambda: 0.0, s3=s3)
    # Same bucket+prefix, so the second call would otherwise be served the first call's cached list
    # and the comparison would be with itself.
    skill_meta._S3_CACHE.clear()
    runtime = catalog_s3_runtime("recon-assets", "skills/", now=lambda: 0.0, s3=s3)
    assert harness == runtime


@mock_aws
def test_unparseable_skill_is_skipped_and_logged(caplog):
    """One typo in one UI-edited file must not black-hole every Tier-2 invocation.

    ``parse_skill`` raises on malformed frontmatter. On the S3 path that exception is caught, logged
    with the offending key, and the skill left out — so the remaining skills still load.
    """
    s3 = _seed()
    s3.put_object(
        Bucket="recon-assets", Key="skills/broken.md", Body=b"---\nname: x\n bad: : :\n---\nb\n"
    )

    with caplog.at_level(logging.ERROR, logger="backend.recon_core.skill_meta"):
        cat = catalog_s3("recon-assets", "skills/", now=lambda: 0.0, s3=s3)

    assert [e["name"] for e in cat] == ["record-match-review"]
    assert "skills/broken.md" in caplog.text


@mock_aws
def test_nameless_skill_is_skipped_and_logged(caplog):
    """A skill the classifier can never match on is dropped rather than padding the prompt."""
    s3 = _seed()
    s3.put_object(
        Bucket="recon-assets", Key="skills/anon.md", Body=b"---\ndescription: no name\n---\nb\n"
    )

    with caplog.at_level(logging.ERROR, logger="backend.recon_core.skill_meta"):
        cat = catalog_s3("recon-assets", "skills/", now=lambda: 0.0, s3=s3)

    assert [e["name"] for e in cat] == ["record-match-review"]
    assert "skills/anon.md" in caplog.text


@mock_aws
def test_catalog_is_cached_per_bucket_and_prefix():
    """A second call inside one invocation must not re-list S3."""
    s3 = _seed()
    assert catalog_s3("recon-assets", "skills/", now=lambda: 0.0, s3=s3)
    s3.put_object(
        Bucket="recon-assets",
        Key="skills/late.md",
        Body=SKILL.replace("record-match-review", "late").encode(),
    )

    cached = catalog_s3("recon-assets", "skills/", now=lambda: 30.0, s3=s3)
    assert [e["name"] for e in cached] == ["record-match-review"]

    expired = catalog_s3("recon-assets", "skills/", now=lambda: 61.0, s3=s3)
    assert sorted(e["name"] for e in expired) == ["late", "record-match-review"]


@mock_aws
@pytest.mark.parametrize("loader", [catalog_s3, catalog_s3_runtime])
def test_default_clock_is_monotonic_in_both_catalogs(loader):
    """Both catalogs share ``skill_meta._S3_CACHE``, so their default clocks must be the same kind.

    One defaulting to ``time.time`` and the other to ``time.monotonic`` is the trap: mixing them in one
    cache means a wall-clock expiry (~1.7e9) always looks valid to a monotonic reader (process uptime),
    pinning that reader to a stale catalog for the life of the process. Asserted on the stored expiry
    rather than on the clock name, since the expiry is what the other reader actually compares against.
    """
    s3 = _seed()
    loader("recon-assets", "skills/", s3=s3)  # no `now` — exercise the default clock

    expiry, _skills = skill_meta._S3_CACHE["recon-assets/skills/"]
    assert expiry < 1e9, f"expiry {expiry} looks like a wall-clock epoch, not monotonic uptime"


@pytest.mark.parametrize("attr", ["_parse", "_parse_list", "_FIELDS", "_CACHE"])
def test_the_duplicate_frontmatter_parser_is_gone(attr):
    """Pinned so nobody reintroduces a second parser next to the shared one."""
    from backend.recon_core import skills_s3

    assert not hasattr(skills_s3, attr), f"skills_s3.{attr} is a duplicate parser, use skill_meta"
