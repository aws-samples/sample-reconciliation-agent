"""Tests for the S3-backed live skills loader (edit-without-redeploy path)."""
import boto3
from moto import mock_aws
from skills_loader import catalog_s3, load_skills_s3

SKILL = """---
name: timing-break
description: Value date differs by a business day.
tools: [search_ledger]
---
Compare the two sides' value dates.
"""


def _seed():
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="recon-assets")
    s3.put_object(Bucket="recon-assets", Key="skills/timing-break.md", Body=SKILL.encode())
    return s3


@mock_aws
def test_catalog_s3_reads_metadata():
    _seed()
    cat = catalog_s3("recon-assets", "skills/", now=lambda: 0.0)
    assert cat[0]["name"] == "timing-break"
    assert cat[0]["tools"] == ["search_ledger"]
    assert "body" not in cat[0]


@mock_aws
def test_load_skills_s3_returns_body_and_caches():
    s3 = _seed()
    loaded = load_skills_s3("recon-assets", "skills/", names=["timing-break"], now=lambda: 0.0, s3=s3)
    assert loaded[0]["body"].startswith("Compare")


@mock_aws
def test_reads_nested_directory_per_skill_layout():
    """Harness layout skills/<name>/SKILL.md is read by the same recursive prefix scan — the
    skill name comes from frontmatter, not the key, so no loader change is needed."""
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="recon-assets")
    s3.put_object(Bucket="recon-assets", Key="skills/timing-break/SKILL.md", Body=SKILL.encode())

    cat = catalog_s3("recon-assets", "skills/", now=lambda: 0.0, s3=s3)
    assert cat[0]["name"] == "timing-break"
    loaded = load_skills_s3(
        "recon-assets", "skills/", names=["timing-break"], now=lambda: 1.0, s3=s3
    )
    assert loaded[0]["body"].startswith("Compare")
