"""Dispatch escalated items to the Tier-2 agent, off the DynamoDB-Stream shard.

Advances the case PENDING -> IN_PROGRESS (guarded) and then async-invokes a thin worker
Lambda (InvocationType=Event). The worker makes the blocking InvokeAgentRuntime call, so the
stream consumer never blocks its shard for the agent's (minutes-long) investigation. The agent
persists its own result (Task 13b), so Tier-1 needs no response.
"""

import hashlib
import re
import json
import os

import boto3

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem
from backend.recon_core.status import CaseStatus


def _session_id(item_id: str) -> str:
    """Derive a stable AgentCore runtimeSessionId (>=33 chars) from the item id.

    AgentCore session ids must match ``[a-zA-Z0-9][a-zA-Z0-9-_]*`` — real item ids carry
    filename characters (dots, ``#``) that violate it, so the item-id portion is sanitized;
    uniqueness comes from the (hex-safe) sha256 suffix.

    :param item_id: the recon item id (may contain arbitrary filename characters).
    :returns: a deterministic, pattern-safe session id.
    """
    safe = re.sub(r"[^a-zA-Z0-9_-]", "-", item_id)
    return f"recon-{safe}-{hashlib.sha256(item_id.encode()).hexdigest()}"[:64]


def _dispatch(agent_arn: str, payload: dict) -> None:
    """Async fire-and-forget invoke of the agent-worker Lambda.

    ``default=str`` because IDP-enriched items carry Decimal attribute values (DynamoDB-safe
    numbers) which plain json.dumps rejects; the agent re-validates via pydantic, which coerces
    the strings back.
    """
    boto3.client("lambda").invoke(
        FunctionName=os.environ["AGENT_WORKER_FUNCTION"],
        InvocationType="Event",  # async; returns immediately
        Payload=json.dumps({"agent_arn": agent_arn, **payload}, default=str).encode(),
    )


def invoke_recon_agent(
    *, agent_arn: str, item: ReconItem, cases: CaseStore, already_in_progress: bool = False
) -> None:
    """Advance PENDING -> IN_PROGRESS (guarded), then async-dispatch the agent worker.

    ``already_in_progress`` is set by the reject re-investigation path, which has already
    transitioned the case, so this call skips the transition and only dispatches.
    """
    if not already_in_progress:
        if not cases.transition("item_id", item.item_id, CaseStatus.IN_PROGRESS):
            return  # another delivery already picked it up (idempotent)
    _dispatch(agent_arn, {"item": item.model_dump(), "session_id": _session_id(item.item_id)})
