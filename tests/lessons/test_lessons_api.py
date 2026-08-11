"""Tests for the read-only lessons BFF."""
import json
import boto3
from moto import mock_aws
from backend.lessons_api.handler import handle
from backend.recon_core.lessons import LessonStore


def _make():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-lessons",
        KeySchema=[{"AttributeName": "lesson_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "lesson_id", "AttributeType": "S"},
            {"AttributeName": "domain", "AttributeType": "S"},
            {"AttributeName": "created_at", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[{
            "IndexName": "domain-index",
            "KeySchema": [{"AttributeName": "domain", "KeyType": "HASH"},
                          {"AttributeName": "created_at", "KeyType": "RANGE"}],
            "Projection": {"ProjectionType": "ALL"}}],
        BillingMode="PAY_PER_REQUEST")


@mock_aws
def test_get_lessons(monkeypatch):
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    _make()
    LessonStore(table="recon-lessons").record(
        item_id="idp-1", domain="cash", class_id="timing", trigger="USER_CORRECTION",
        disposition="REPROCESS", user_comment="T+1")
    out = handle({"routeKey": "GET /lessons", "queryStringParameters": {"domain": "cash"}}, None)
    assert out["statusCode"] == 200
    assert json.loads(out["body"])[0]["user_comment"] == "T+1"


@mock_aws
def test_unknown_route_404(monkeypatch):
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    assert handle({"routeKey": "POST /lessons"}, None)["statusCode"] == 404
