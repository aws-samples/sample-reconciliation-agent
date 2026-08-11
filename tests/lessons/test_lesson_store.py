"""Tests for the durable lessons ledger."""
import boto3
from moto import mock_aws
from backend.recon_core.lessons import LessonStore


def _make_lessons_table():
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
            "KeySchema": [
                {"AttributeName": "domain", "KeyType": "HASH"},
                {"AttributeName": "created_at", "KeyType": "RANGE"},
            ],
            "Projection": {"ProjectionType": "ALL"},
        }],
        BillingMode="PAY_PER_REQUEST",
    )


@mock_aws
def test_record_and_list_by_domain():
    _make_lessons_table()
    s = LessonStore(table="recon-lessons")
    s.record(item_id="idp-1", domain="cash", class_id="timing", trigger="USER_CORRECTION",
             disposition="REPROCESS", user_comment="value date is T+1, re-check")
    rows = s.list_recent(domain="cash")
    assert len(rows) == 1
    assert rows[0]["user_comment"].startswith("value date")
    assert rows[0]["trigger"] == "USER_CORRECTION"


@mock_aws
def test_record_is_idempotent_per_item_and_trigger():
    _make_lessons_table()
    s = LessonStore(table="recon-lessons")
    s.record(item_id="idp-1", domain="cash", class_id="x", trigger="USER_APPROVED")
    s.record(item_id="idp-1", domain="cash", class_id="x", trigger="USER_APPROVED")
    assert len(s.list_recent(domain="cash")) == 1
