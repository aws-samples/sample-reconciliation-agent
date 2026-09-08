"""Dispatch escalated items to the Tier-2 agent, keeping the work off the DynamoDB Stream shard.

Two steps: advance the case from PENDING to IN_PROGRESS under the state-machine guard, then invoke a
thin worker Lambda asynchronously. The worker is the one that makes the blocking call into the agent
runtime, which means the stream consumer never holds its shard open for the minutes an investigation
takes. Nothing here reads a response, because the agent persists its own result.
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
    """Derive a stable AgentCore runtime session id from the item id, at least 33 characters long.

    AgentCore requires session ids to match ``[a-zA-Z0-9][a-zA-Z0-9-_]*``, and real item ids do not:
    they carry filename characters like dots and ``#``. So the item-id portion is sanitised down to
    that alphabet, and uniqueness comes from the sha256 suffix, which is hex and therefore always
    safe. Deriving it rather than generating one keeps a redelivered item on the same session.

    :param item_id: the recon item id, which may contain arbitrary filename characters.
    :returns: a deterministic session id that satisfies the pattern.
    """
    safe = re.sub(r"[^a-zA-Z0-9_-]", "-", item_id)
    return f"recon-{safe}-{hashlib.sha256(item_id.encode()).hexdigest()}"[:64]


def _dispatch(agent_arn: str, payload: dict) -> None:
    """Fire the agent-worker Lambda asynchronously and return without waiting.

    ``default=str`` is required, not cosmetic. Items enriched from extracted documents carry
    ``Decimal`` attribute values, because that is what DynamoDB gives back for numbers, and plain
    ``json.dumps`` refuses to serialise them. Stringifying is safe here: the agent re-validates the
    payload through pydantic, which coerces the strings back to numbers.

    :param agent_arn: the AgentCore runtime ARN the worker should invoke.
    :param payload: the rest of the worker event, merged in alongside the ARN.
    :returns: None
    """
    boto3.client("lambda").invoke(
        FunctionName=os.environ["AGENT_WORKER_FUNCTION"],
        InvocationType="Event",  # async, so this returns as soon as Lambda accepts the event
        Payload=json.dumps({"agent_arn": agent_arn, **payload}, default=str).encode(),
    )


def invoke_recon_agent(
    *, agent_arn: str, item: ReconItem, cases: CaseStore, already_in_progress: bool = False
) -> None:
    """Advance the case from PENDING to IN_PROGRESS under the guard, then dispatch the agent worker.

    :param agent_arn: the AgentCore runtime ARN to investigate with.
    :param item: the escalated item, forwarded to the worker in full.
    :param cases: the case store, used for the guarded transition.
    :param already_in_progress: set by the reject-and-reinvestigate path, which has already moved the
        case itself. This call then only dispatches, because a second transition would be refused and
        the dispatch would be skipped along with it.
    :returns: None
    """
    if not already_in_progress:
        if not cases.transition("item_id", item.item_id, CaseStatus.IN_PROGRESS):
            # Another stream delivery already claimed this item and dispatched it. Returning here is
            # what makes a redelivered record cost nothing instead of a second investigation.
            return
    _dispatch(agent_arn, {"item": item.model_dump(), "session_id": _session_id(item.item_id)})
