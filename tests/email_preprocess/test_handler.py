"""Tests for the pre-processor Lambda's handler."""

import boto3
import pytest
from moto import mock_aws

from backend.email_preprocess.handler import handler
from tests.email_preprocess.fixtures.build_fixtures import (
    alternative_eml,
    simple_eml,
    with_attachment_eml,
)

BUCKET = "recon-dev-assets"


@pytest.fixture
def bucket(monkeypatch) -> str:
    """Create the staging bucket and point the handler at it.

    Returns:
        The bucket name.
    """
    monkeypatch.setenv("UPLOAD_STAGING_BUCKET", BUCKET)
    # The handler builds its client with no explicit region, and nothing in the session sets
    # one, so without this it fails with NoRegionError before moto is ever consulted.
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
        yield BUCKET


def test_body_becomes_a_pdf_part(bucket: str) -> None:
    s3 = boto3.client("s3", region_name="us-east-1")
    source_key = "uploads/inbox/sub-1/query.eml"
    s3.put_object(Bucket=bucket, Key=source_key, Body=simple_eml())

    result = handler(
        {"submission_id": "sub-1", "source_key": source_key, "filename": "query.eml"},
        None,
    )

    assert len(result["parts"]) == 1
    part = result["parts"][0]
    assert part["kind"] == "body"
    assert part["filename"] == "query.pdf"
    assert part["content_type"] == "application/pdf"
    assert part["subject"] == "Fee query"
    body = s3.get_object(Bucket=bucket, Key=part["key"])["Body"].read()
    assert body.startswith(b"%PDF-")


def test_attachment_keeps_its_own_name_and_type(bucket: str) -> None:
    s3 = boto3.client("s3", region_name="us-east-1")
    source_key = "uploads/inbox/sub-2/query.eml"
    s3.put_object(Bucket=bucket, Key=source_key, Body=with_attachment_eml())

    result = handler(
        {"submission_id": "sub-2", "source_key": source_key, "filename": "query.eml"}, None
    )

    kinds = [p["kind"] for p in result["parts"]]
    assert kinds == ["body", "attachment"]
    attached = result["parts"][1]
    assert attached["filename"] == "notice.pdf"
    assert attached["attachment_format"] == "pdf"
    # Each derived part gets its own key under the submission, so two attachments with the
    # same name in one email cannot overwrite each other.
    assert attached["key"].startswith("uploads/derived/sub-2/")
    assert attached["key"] != result["parts"][0]["key"]


def test_an_html_only_email_returns_the_reason_rather_than_raising(bucket: str) -> None:
    # The route shows this string against the file. A raise would surface as a generic
    # invocation error and the operator would learn nothing about which file was wrong.
    #
    # The fixture is a REAL email that happens to carry only an HTML body, built by
    # `alternative_eml(drop_plain=True)`. Feeding in arbitrary garbage would not exercise this
    # path at all: `email.message_from_bytes` treats an unparseable blob as a defective but
    # valid text/plain message, so it comes back WITH a body and nothing is ever refused.
    s3 = boto3.client("s3", region_name="us-east-1")
    source_key = "uploads/inbox/sub-3/html-only.eml"
    s3.put_object(Bucket=bucket, Key=source_key, Body=alternative_eml(drop_plain=True))

    result = handler(
        {"submission_id": "sub-3", "source_key": source_key, "filename": "html-only.eml"}, None
    )

    assert result["parts"] == []
    assert "no text/plain" in result["error"]


def test_a_file_that_is_not_an_email_at_all_is_refused_not_indexed(bucket: str) -> None:
    # Named `.msg`, so it takes the Outlook branch, where garbage genuinely cannot be parsed --
    # unlike the `.eml` branch, whose parser accepts anything. Without this case a corrupt upload
    # would reach whichever destination the submission chose and be indexed as a document.
    s3 = boto3.client("s3", region_name="us-east-1")
    source_key = "uploads/inbox/sub-4/bad.msg"
    s3.put_object(Bucket=bucket, Key=source_key, Body=b"not an email at all")

    result = handler(
        {"submission_id": "sub-4", "source_key": source_key, "filename": "bad.msg"}, None
    )

    assert result["parts"] == []
    assert result["error"]


def test_a_missing_source_object_raises(bucket: str) -> None:
    # This one is not an operator error -- it means the route's own put did not happen, or the
    # bucket is wrong. Swallowing it would hide a broken deployment behind a per-file message.
    with pytest.raises(Exception):
        handler({"submission_id": "s", "source_key": "nope.eml", "filename": "nope.eml"}, None)
