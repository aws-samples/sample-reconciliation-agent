"""A fake S3 client for the seed-push reconciliation, so it can be tested with no AWS account.

This stubs the boto3 client, not the `aws` binary: the reconciliation runs inside the deploy-actions
Lambda and is boto3-only, so that an apply does not depend on the CLI being installed on whatever
machine runs Terraform.

⚠️ It records WRITES SEPARATELY from state (`puts` vs `objects`). Several of the outcomes this
reconciliation must get right are "leave everything alone", and re-writing identical bytes is
invisible in the resulting state — so asserting on content alone would pass a version that clobbers
an analyst's edit with the same value it already had, and would miss a conflict that wrote before
failing.
"""

import hashlib
import io
from pathlib import Path
import sys

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
# seed_push ships beside the Lambda handler so it lands in the deployment zip.
sys.path.insert(0, str(REPO_ROOT / "infra" / "modules" / "deploy-actions" / "src"))


def md5(text: str) -> str:
    """MD5 hex of a string, matching what S3 reports as the ETag of a single-part object.

    :param text: the content to digest.
    :returns: 32-character lowercase hex digest.
    """
    return hashlib.md5(text.encode()).hexdigest()


def _client_error(code: str) -> Exception:
    """An exception shaped like botocore's ClientError, carrying an error code.

    :param code: the AWS error code to expose at ``response["Error"]["Code"]``.
    :returns: the exception instance, ready to raise.
    """
    exc = RuntimeError(code)
    exc.response = {"Error": {"Code": code}}
    return exc


class FakeS3:
    """An in-memory S3 stand-in covering the five calls the reconciliation makes."""

    def __init__(self):
        """Start with an empty, SSE-S3-encrypted bucket."""
        self.objects: dict[str, dict] = {}
        self.puts: list[str] = []
        self.encryption: str | None = "AES256"
        # When true, get_bucket_encryption fails the way a missing IAM grant does.
        self.access_denied = False

    # --- test-side setup (does NOT count as a write by the code under test) ---

    def put(self, key: str, body: str, etag: str | None = None) -> None:
        """Pre-populate an object.

        :param key: object key.
        :param body: object content.
        :param etag: override the ETag, to simulate a multipart upload.
        """
        self.objects[key] = {"body": body, "etag": etag or md5(body)}

    # --- boto3 client surface ---

    def get_bucket_encryption(self, **_kw):
        if self.access_denied:
            raise _client_error("AccessDenied")
        if self.encryption is None:
            # Shaped like botocore's ClientError, because the code under test distinguishes this
            # specific code from every other failure and a bare exception would not exercise that.
            raise _client_error("ServerSideEncryptionConfigurationNotFoundError")
        return {
            "ServerSideEncryptionConfiguration": {
                "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": self.encryption}}]
            }
        }

    def head_object(self, *, Bucket, Key):  # noqa: N803 - boto3's parameter casing
        if Key not in self.objects:
            raise RuntimeError("NoSuchKey")
        return {"ETag": f'"{self.objects[Key]["etag"]}"'}

    def get_object(self, *, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise RuntimeError("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key]["body"].encode("utf-8"))}

    def put_object(self, *, Bucket, Key, Body, ContentType=None):  # noqa: N803
        text = Body.decode("utf-8") if isinstance(Body, bytes) else Body
        self.objects[Key] = {"body": text, "etag": md5(text)}
        self.puts.append(Key)
        return {}


@pytest.fixture
def fake_s3():
    """A fresh FakeS3 per test."""
    return FakeS3()
