"""Optional S3 text reads: which errors mean "nothing here" is the caller's call, the rest raise."""

import io
import logging

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from backend.recon_core.s3_text import read_text


class _S3:
    """GetObject as a role without ``s3:ListBucket`` sees it: keys not in ``objects`` are denied."""

    def __init__(self, objects: dict[str, bytes], code: str = "AccessDenied"):
        self.objects, self.code = objects, code

    def get_object(self, Bucket, Key):  # noqa: N803 - boto3's parameter names
        if Key in self.objects:
            return {"Body": io.BytesIO(self.objects[Key])}
        raise ClientError({"Error": {"Code": self.code, "Message": "denied"}}, "GetObject")


@mock_aws
def test_reads_utf8_text_and_falls_back_on_a_missing_key():
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="assets")
    assert read_text(s3, "assets", "prompts/x.md") is None
    assert read_text(s3, "assets", "prompts/x.md", default="built-in") == "built-in"
    s3.put_object(Bucket="assets", Key="prompts/x.md", Body="seeded é".encode())
    assert read_text(s3, "assets", "prompts/x.md", default="built-in") == "seeded é"


def test_a_denied_read_is_not_missing_unless_the_caller_says_so(caplog):
    # "Not there" and "may not read" are different answers; only a caller who knows its role
    # lacks ListBucket may fold the second into the first, and the WARNING has to name the code.
    s3 = _S3({}, "AccessDenied")
    with pytest.raises(ClientError):
        read_text(s3, "assets", "security-master/issuers.csv", default="")
    with caplog.at_level(logging.WARNING, logger="backend.recon_core.s3_text"):
        assert (
            read_text(
                s3,
                "assets",
                "security-master/issuers.csv",
                default="",
                tolerate_codes={"NoSuchKey", "AccessDenied", "403"},
            )
            == ""
        )
    assert "s3://assets/security-master/issuers.csv not read (AccessDenied)" in caplog.text


@pytest.mark.parametrize("code", ["NoSuchKey", "NotFound"])
def test_the_default_tolerance_is_a_key_that_does_not_exist(code):
    assert read_text(_S3({}, code), "assets", "k", default="d") == "d"


def test_errors_that_are_not_client_errors_propagate():
    class Broken:
        def get_object(self, **_kwargs):
            raise OSError("socket closed")

    with pytest.raises(OSError):
        read_text(Broken(), "assets", "k", default="d")
