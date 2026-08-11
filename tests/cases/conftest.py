"""Shared fixtures for the cases BFF tests (exposed via pytest fixtures, not imports)."""

import boto3
import pytest


def _make_case_tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "status", "AttributeType": "S"},
            {"AttributeName": "created_at", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "status-index",
                "KeySchema": [
                    {"AttributeName": "status", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName="recon-audit",
        KeySchema=[
            {"AttributeName": "item_id", "KeyType": "HASH"},
            {"AttributeName": "ts", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "ts", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _seed_case(item_id: str, *, status: str, resolution: str | None = None):
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    row = {
        "item_id": item_id,
        "status": status,
        "created_at": "2026-07-15T00:00:00",
        "tier": 2,
        "item": {"item_id": item_id, "domain": "cash", "sides": []},
    }
    if resolution is not None:
        row["resolution"] = resolution
    ddb.Table("recon-cases").put_item(Item=row)


@pytest.fixture
def make_case_tables():
    """Return the table-creation helper (call inside a moto context)."""
    return _make_case_tables


@pytest.fixture
def seed_case():
    """Return the case-seeding helper (call inside a moto context)."""
    return _seed_case
