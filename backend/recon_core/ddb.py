"""Thin DynamoDB access helpers for the reconciliation flow.

Stores only recon-flow state (items, cases, audit) — never classification-type definitions,
which live in the SKILL.md files.
"""

import boto3
from botocore.exceptions import ClientError

from backend.recon_core.schema import ReconItem


class ItemStore:
    """DynamoDB accessor for ReconItem rows in the recon-items table."""

    def __init__(self, table_name: str):
        """Bind to the named DynamoDB table via the default boto3 session."""
        self._table = boto3.resource("dynamodb").Table(table_name)

    def put_if_absent(self, item: ReconItem) -> bool:
        """Write a ReconItem only if its item_id does not already exist.

        Returns True when the row was newly created, False when an item with the same
        item_id already existed (a resubmission), so callers never re-trigger downstream
        processing for an item already in flight.
        """
        try:
            self._table.put_item(
                Item=item.model_dump(),
                ConditionExpression="attribute_not_exists(item_id)",
            )
            return True
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise

    def get(self, item_id: str) -> ReconItem:
        """Fetch a ReconItem by id, raising KeyError if it does not exist."""
        resp = self._table.get_item(Key={"item_id": item_id})
        if "Item" not in resp:
            raise KeyError(f"item {item_id} not found")
        return ReconItem.model_validate(resp["Item"])
