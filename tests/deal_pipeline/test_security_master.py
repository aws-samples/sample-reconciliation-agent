"""Issuer matching and counterparty canonicalization over the fictional reference data."""

import io

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from backend.deal_pipeline.security_master import SecurityMaster

COUNTERPARTIES_CSV = b"canonical_name,aliases\nBlue Ridge,Blue Ridge Financial;BRF\n"


class DenyingS3:
    """An S3 client whose GetObject answers as a role without ``s3:ListBucket`` sees it: the objects
    in ``objects`` are served, anything else is 403 AccessDenied rather than 404 NoSuchKey."""

    def __init__(self, objects: dict[str, bytes], code: str = "AccessDenied"):
        self.objects, self.code, self.requested = objects, code, []

    def get_object(self, Bucket, Key):  # noqa: N803 - boto3's parameter names
        self.requested.append(Key)
        if Key in self.objects:
            return {"Body": io.BytesIO(self.objects[Key])}
        raise ClientError({"Error": {"Code": self.code, "Message": "denied"}}, "GetObject")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "Cascade Midstream Partners, LLC - $700MM First Lien Term Loan B - Launch",
            "Cascade Midstream Partners",
        ),
        ("Summit Safety Services, Inc.", "Summit Safety Services"),
        ("Heritage Roots Buyer Inc.", "Heritage Roots"),
        ("Ridgeline Packaging Corp.", "Ridgeline Packaging"),
        ("northwind automotive", "Northwind Automotive"),
        (
            "Northwind US LLC and Northwind Global Holdings S.a r.l. are the borrowers",
            "Northwind Automotive",
        ),
        ("(NYSE: NWND)", "Northwind Automotive"),
        ('Copperfield Insurance Partners ("Copperfield")', "Copperfield Insurance Partners"),
        ("Lakeside Imaging Holdings, Inc.", "Lakeside Imaging Holdings"),
    ],
)
def test_match_issuer(security_master, text, expected):
    assert security_master.match_issuer(text)["issuer_name"] == expected


@pytest.mark.parametrize("text", ["Unknown Holdings", "Northwinds", "", "Cascade"])
def test_match_issuer_requires_whole_words(security_master, text):
    assert security_master.match_issuer(text) is None


def test_match_issuer_returns_row_with_alias_list(security_master):
    row = security_master.match_issuer("Northwind Automotive")
    assert row["aliases"] == ["Northwind US LLC", "Northwind Global Holdings", "NWND"]
    assert row["region"] == "North America"
    assert row["asset_id"] == "SM-100231"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Silverline", ("Silverline", "Silverline")),
        ("silverline", ("Silverline", "Silverline")),
        ("Silverline Partners", (None, "Silverline")),  # alias: suggested, not accepted
        ("Harbor Point Securities", (None, "Harbor Point")),
        ("HPS", (None, "Harbor Point")),
        ("Kestrel Bank N.A.", (None, "Kestrel")),
        ("Westbrook & Co.", (None, "Westbrook")),
        ("Westbrook and Co", (None, "Westbrook")),
        ("Ashgrove Capital Mkts", (None, "Ashgrove")),  # close-match fallback
        ("Silverline Partners-led arranger group", (None, "Silverline")),  # buried in prose
        ("Goldfinch Bank", (None, None)),
        ("", (None, None)),
    ],
)
def test_canonical_counterparty(security_master, name, expected):
    assert security_master.canonical_counterparty(name) == expected


def test_canonical_names_in_file_order(security_master):
    assert security_master.canonical_names()[:3] == ["Harbor Point", "Ashgrove", "Kestrel"]


def test_from_csv_text_tolerates_empty_halves():
    sm = SecurityMaster.from_csv_text("", "canonical_name,aliases\nKestrel,\n")
    assert sm.issuers == []
    assert sm.match_issuer("Kestrel") is None
    assert sm.canonical_counterparty("Kestrel") == ("Kestrel", "Kestrel")


@mock_aws
def test_from_s3_missing_object_counts_as_empty(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="assets")
    s3.put_object(
        Bucket="assets",
        Key="security-master/counterparties.csv",
        Body=b"canonical_name,aliases\nBlue Ridge,Blue Ridge Financial;BRF\n",
    )
    sm = SecurityMaster.from_s3(s3, "assets", "security-master")  # prefix without trailing slash
    assert sm.issuers == []
    assert sm.canonical_counterparty("BRF") == (None, "Blue Ridge")


@pytest.mark.parametrize("code", ["AccessDenied", "403", "NoSuchKey", "404"])
def test_from_s3_missing_or_denied_object_counts_as_empty(code):
    s3 = DenyingS3({"security-master/counterparties.csv": COUNTERPARTIES_CSV}, code)
    sm = SecurityMaster.from_s3(s3, "assets", "security-master/")
    assert sm.issuers == []
    assert sm.canonical_counterparty("BRF") == (None, "Blue Ridge")


def test_from_s3_propagates_errors_that_do_not_mean_missing():
    s3 = DenyingS3({}, "InternalError")
    with pytest.raises(ClientError):
        SecurityMaster.from_s3(s3, "assets", "security-master/")


def test_counterparties_from_s3_reads_exactly_one_object():
    s3 = DenyingS3({"reference/cp.csv": COUNTERPARTIES_CSV})
    sm = SecurityMaster.counterparties_from_s3(s3, "assets", "reference/cp.csv")
    assert s3.requested == ["reference/cp.csv"]  # never asks for issuers.csv
    assert sm.issuers == [] and sm.canonical_names() == ["Blue Ridge"]


def test_counterparties_from_s3_denied_is_an_empty_list():
    sm = SecurityMaster.counterparties_from_s3(DenyingS3({}), "assets", "reference/cp.csv")
    assert sm.canonical_names() == [] and sm.canonical_counterparty("Kestrel") == (None, None)
