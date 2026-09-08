"""Tests for the IdpOutputReader (reads section results + page images from IDP output S3)."""

import json
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.idp_hook.idp_output import IdpOutputReader

BUCKET = "idp-out"
PREFIX = "Notice.pdf"


def _seed():
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=BUCKET)
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{PREFIX}/sections/1/result.json",
        Body=json.dumps(
            {
                "document_class": {"type": "LoanRateSettingNotice"},
                "split_document": {"page_indices": [0]},
                "inference_result": {"AgencyName": "Meridian", "GlobalAmount": 150800000.0},
            }
        ),
    )
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{PREFIX}/sections/2/result.json",
        Body=json.dumps(
            {
                "document_class": {"type": "LoanPaymentNotice"},
                "inference_result": {"Facility": "TL-A"},
            }
        ),
    )
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pages/1/image.jpg", Body=b"\xff\xd8jpg1")
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pages/2/image.jpg", Body=b"\xff\xd8jpg2")
    # Noise that must be ignored.
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pages/1/rawText.json", Body=b"{}")


@mock_aws
def test_reads_sections_sorted_with_classification_and_fields():
    _seed()
    out = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)
    secs = out["sections"]
    assert [s["section_id"] for s in secs] == ["1", "2"]  # numeric sort, not lexical
    assert secs[0]["classification"] == "LoanRateSettingNotice"
    assert secs[0]["fields"]["AgencyName"] == "Meridian"
    # Float extracted values are Decimal-safe for DynamoDB.
    assert isinstance(secs[0]["fields"]["GlobalAmount"], Decimal)


@mock_aws
def test_reads_only_page_images_as_uris():
    _seed()
    out = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)
    pages = out["pages"]
    assert [p["page_id"] for p in pages] == ["1", "2"]
    assert pages[0]["image_uri"] == f"s3://{BUCKET}/{PREFIX}/pages/1/image.jpg"
    # rawText.json must not appear as a page.
    assert all(p["image_uri"].endswith("image.jpg") for p in pages)


@mock_aws
def test_trailing_slash_prefix_is_tolerated():
    _seed()
    out = IdpOutputReader().read(bucket=BUCKET, prefix=f"{PREFIX}/")
    assert len(out["sections"]) == 2


@mock_aws
def test_copy_pages_to_assets_adds_local_key():
    """Page images are copied into recon's own assets bucket at ingest so the UI serves them
    same-origin (no runtime read of IDP storage). Each page gains a local_key."""
    _seed()
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="recon-assets")
    reader = IdpOutputReader()
    pages = reader.read(bucket=BUCKET, prefix=PREFIX)["pages"]
    out = reader.copy_pages(pages, dest_bucket="recon-assets", item_id="idp-Notice.pdf")
    assert out[0]["local_key"] == "idp-pages/idp-Notice.pdf/page-1.jpg"
    # The object actually exists in the destination bucket.
    body = s3.get_object(Bucket="recon-assets", Key=out[0]["local_key"])["Body"].read()
    assert body.startswith(b"\xff\xd8")


@mock_aws
def test_copy_pages_failure_keeps_pages_without_local_key():
    """A copy failure must not drop the ingest — pages stay, just without local_key."""
    _seed()  # note: dest bucket NOT created -> copy fails
    reader = IdpOutputReader()
    pages = reader.read(bucket=BUCKET, prefix=PREFIX)["pages"]
    out = reader.copy_pages(pages, dest_bucket="missing-bucket", item_id="x")
    assert len(out) == 2
    assert all("local_key" not in p for p in out)


@mock_aws
def test_resolve_document_returns_an_uncompressed_record_untouched():
    """Small documents arrive whole, and resolution must be a no-op for them — no S3 call at all.

    Pinned with NO bucket created: if the method ever reads S3 unconditionally this fails on
    NoSuchBucket rather than quietly costing a GET per invocation.

    :returns: None.
    """
    document = {"id": "doc-1", "sections": [{"section_id": "1"}]}
    assert IdpOutputReader().resolve_document(document) is document


@mock_aws
def test_resolve_document_follows_the_compressed_pointer():
    """The stand-in names a working-bucket object holding the real record; return THAT record.

    The stand-in's own keys must not survive: its ``sections`` is a list of id strings and its
    ``status`` is the pre-completion ``EVALUATING``, so merging the two shapes would keep exactly the
    values that break the mapper.

    :returns: None.
    """
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="idp-working")
    real = {"id": "doc-1", "output_bucket": BUCKET, "sections": [{"section_id": "1"}]}
    s3.put_object(
        Bucket="idp-working", Key="compressed_documents/doc-1/1.json", Body=json.dumps(real).encode()
    )

    resolved = IdpOutputReader().resolve_document(
        {
            "document_id": "doc-1",
            "s3_uri": "s3://idp-working/compressed_documents/doc-1/1.json",
            "sections": ["1"],
            "status": "EVALUATING",
            "compressed": True,
        }
    )

    assert resolved == real


@mock_aws
def test_resolve_document_raises_when_the_pointer_is_missing():
    """`compressed` with no s3_uri is unrecoverable, and the message has to name the document.

    :returns: None.
    """
    with pytest.raises(ValueError, match="marked compressed but has no usable s3_uri"):
        IdpOutputReader().resolve_document({"document_id": "doc-1", "compressed": True})
