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

    def put_and_detect_reprocess(self, item: ReconItem) -> str:
        """Write an item, distinguishing first-ingest / reprocess / duplicate.

        Used by the IDP hook, where ``item_id`` is filename-derived so a genuine reprocess (a
        NEW IDP run of the same document) collides with the original ingest. The run identity
        lives in ``attributes.idp_execution_arn``:

        - no existing row                         -> write, return ``"created"``
        - existing row, DIFFERENT execution arn   -> overwrite, return ``"reprocessed"``
        - existing row, SAME execution arn         -> no write, return ``"duplicate"``
          (a re-delivered completion event — preserves the original idempotency guard)

        An existing row with an empty stored arn is treated as reprocess when the incoming arn
        is non-empty, so pre-existing items (written before this field existed) re-drive once.

        :param item: the freshly mapped ReconItem (its attributes carry idp_execution_arn).
        :returns: one of ``"created"``, ``"reprocessed"``, ``"duplicate"``.
        """
        incoming_arn = str(item.attributes.get("idp_execution_arn") or "")
        resp = self._table.get_item(Key={"item_id": item.item_id})
        existing = resp.get("Item")
        if existing is None:
            self._table.put_item(Item=item.model_dump())
            return "created"
        existing_arn = str((existing.get("attributes") or {}).get("idp_execution_arn") or "")
        if incoming_arn and incoming_arn == existing_arn:
            return "duplicate"
        # Different (or newly-known) run id -> genuine reprocess: refresh the item in place.
        self._table.put_item(Item=item.model_dump())
        return "reprocessed"
