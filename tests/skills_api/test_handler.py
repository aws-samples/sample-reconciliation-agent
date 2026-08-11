"""Tests for the read-only skills-catalog BFF."""

import json

import boto3
from moto import mock_aws

from backend.skills_api.handler import handle


@mock_aws
def test_get_skills_returns_published_catalog(monkeypatch):
    monkeypatch.setenv("ASSETS_BUCKET", "recon-assets")
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="recon-assets")
    catalog = [
        {
            "name": "record-match-review",
            "description": "Compare sides",
            "severity": "LOW",
            "confidence_threshold": 0.8,
            "deterministic_eligible": True,
        }
    ]
    s3.put_object(
        Bucket="recon-assets", Key="skills-catalog.json", Body=json.dumps(catalog).encode()
    )
    out = handle({"routeKey": "GET /skills"}, None)
    assert out["statusCode"] == 200
    body = json.loads(out["body"])
    assert body[0]["name"] == "record-match-review"
    assert body[0]["confidence_threshold"] == 0.8


@mock_aws
def test_unknown_route_returns_404():
    assert handle({"routeKey": "POST /skills"}, None)["statusCode"] == 404
