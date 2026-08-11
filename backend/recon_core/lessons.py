"""Durable lessons-learned ledger. One item per captured lesson (user correction or approval).

This is the system of record for lessons — the authoritative, queryable, auditable store that
drives the UI tab and the agent's consult-lessons retrieval, independent of AgentCore Memory
(Memory is the semantic-retrieval enhancement layered on top).
"""

import time

import boto3


class LessonStore:
    """Accessor for the recon-lessons DynamoDB table."""

    def __init__(self, table: str):
        """Bind to the lessons table via the default boto3 session."""
        self._t = boto3.resource("dynamodb").Table(table)

    def _now(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())

    def record(
        self,
        *,
        item_id: str,
        domain: str,
        class_id: str | None,
        trigger: str,
        disposition: str | None = None,
        user_comment: str | None = None,
        prior_recommendation: str | None = None,
    ) -> str:
        """Write a lesson. Idempotent per (item_id, trigger) so repeated decisions don't dup.

        ``trigger`` is USER_CORRECTION or USER_APPROVED; ``disposition`` is the chosen outcome
        (e.g. NO_FURTHER_ACTION / REPROCESS). Returns the lesson_id.
        """
        lesson_id = f"{item_id}#{trigger}"
        self._t.put_item(
            Item={
                "lesson_id": lesson_id,
                "created_at": self._now(),
                "domain": domain,
                "class_id": class_id or "unknown",
                "item_id": item_id,
                "trigger": trigger,
                "disposition": disposition,
                "user_comment": user_comment,
                "prior_recommendation": prior_recommendation,
            }
        )
        return lesson_id

    def list_recent(self, *, domain: str | None = None) -> list[dict]:
        """Return lessons, optionally filtered by domain, for the UI / agent retrieval.

        Uses the domain GSI when a domain is given; otherwise scans (lessons volume is low).
        """
        if domain:
            resp = self._t.query(
                IndexName="domain-index",
                KeyConditionExpression="#d = :d",
                ExpressionAttributeNames={"#d": "domain"},
                ExpressionAttributeValues={":d": domain},
                ScanIndexForward=False,
            )
            return resp.get("Items", [])
        return self._t.scan().get("Items", [])
