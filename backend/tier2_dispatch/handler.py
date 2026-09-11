"""Dispatcher Lambda: start one investigation with a task token attached, then return.

Invoked by the Tier-2 state machine through ``lambda:invoke.waitForTaskToken``. Step Functions passes
a task token, pauses the execution, and this function hands that token to the agent and returns. The
agent backgrounds the investigation (``@app.async_task``) and calls ``SendTaskSuccess`` when it has a
result, which is what resumes the execution.

The point is what is NOT here. ``backend/tier1/agent_worker.py`` blocks for the whole investigation on
a response nothing reads, so its billed duration tracks the agent's thinking time. This function's
billed duration is flat: it serialises a request, signs it, and returns.

Consequently this module needs none of the worker's budget machinery — no
``_remaining_budget_seconds``, no ``_BUDGET_RESERVE_SECONDS``, no timeout derived from the caller's
deadline. A fixed short timeout is correct here precisely because there is no multi-minute read to
size, which is the opposite of the situation that made a hard-coded timeout a bug in the worker.
"""

import json
import logging
import os
import urllib.error

import boto3

from backend.recon_core.otel_client import (
    otel_headers,
    register_trace_propagation,
    set_recon_baggage,
    traced,
)
from backend.tier1.ingress_invoke import invoke_via_ingress

logger = logging.getLogger(__name__)

# Seconds allowed for the dispatch call itself. A fixed constant, not a budget: the agent returns
# {"status": "accepted"} as soon as it has scheduled the work, so this covers a signed HTTPS round
# trip and nothing more. 25s against a 30s function timeout leaves room to log the failure.
_DISPATCH_TIMEOUT_SECONDS = 25.0


def _is_timeout(exc: BaseException) -> bool:
    """Is this a request timeout, meaning the dispatch may have landed, or a delivery failure?

    Same distinction, and the same stakes, as ``agent_worker._is_timeout``. A timeout here is
    ambiguous: the runtime may have accepted the invocation and started an investigation that will
    signal the token on its own. Falling back would then start a SECOND investigation of the same
    item against the same session. Anything else proves nothing ran, so a fallback costs nothing.

    A read-phase timeout arrives as ``TimeoutError`` (``socket.timeout`` has been an alias since
    Python 3.10); a connect-phase one arrives wrapped in ``URLError`` with the original on ``reason``.

    :param exc: the exception raised by the dispatch attempt.
    :returns: True if it represents a timeout.
    """
    if isinstance(exc, TimeoutError):
        return True
    # An HTTPError cannot reach the second branch despite subclassing URLError, because its `reason`
    # is a string. That is what we want: a status code means the gateway answered, which is a
    # delivery outcome rather than a timeout.
    return isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, TimeoutError)


def _invoke_direct(*, agent_arn: str, session_id: str, payload: dict) -> int:
    """Call InvokeAgentRuntime directly, bypassing the ingress gateway.

    :param agent_arn: the AgentCore runtime ARN to invoke.
    :param session_id: stable AgentCore runtime session id, derived from the item id.
    :param payload: the invocation payload, including ``taskToken``.
    :returns: the runtime invocation's HTTP status code.
    """
    from botocore.config import Config

    # max_attempts=1: botocore retries a ReadTimeoutError by default, and for this API a read timeout
    # does not mean the request failed. The retry would not recover the first dispatch, it would
    # schedule a second investigation alongside it.
    client = boto3.client(
        "bedrock-agentcore",
        config=Config(
            connect_timeout=5,
            read_timeout=_DISPATCH_TIMEOUT_SECONDS,
            retries={"max_attempts": 1, "mode": "standard"},
        ),
    )
    # boto3 does not propagate trace context on its own; this hook writes it onto the signed request.
    register_trace_propagation(client)
    with traced(
        "dispatch_agent_runtime",
        attributes={
            "gen_ai.agent.arn": agent_arn,
            "session.id": session_id,
            "recon.transport": "direct",
        },
    ):
        resp = client.invoke_agent_runtime(
            agentRuntimeArn=agent_arn,
            runtimeSessionId=session_id,
            payload=json.dumps(payload).encode(),
        )
        return resp.get("statusCode", 200)


def handle(event, _context):
    """Dispatch one investigation and return without waiting for it.

    :param event: ``{"agent_arn": str, "item": {...}, "session_id": str, "taskToken": str}``.
    :param _context: the Lambda context (unused — there is no budget to derive here).
    :returns: ``{"dispatched": True, "path": "ingress"|"direct", "statusCode": int}``.
    :raises KeyError: when a required key is absent. Failing loudly is right: the state is paused on
        a token that only the agent can release, so a silent no-op would hang until TimeoutSeconds.
    :raises Exception: re-raises any dispatch failure, so the Task fails immediately instead of
        waiting out its timeout on a request that never left.
    """
    agent_arn = event["agent_arn"]
    session_id = event["session_id"]
    task_token = event["taskToken"]
    item = event["item"]

    # The token rides on the payload; the agent branches on its presence to decide whether to
    # background the work. Everything else is forwarded unchanged, because the deterministic
    # `tier1_*` keys are already on the item and rebuilding the payload is how one gets dropped.
    payload = {"item": item, "taskToken": task_token}

    set_recon_baggage(
        item_id=str(item.get("item_id", "")),
        domain=str(item.get("domain", "")),
        backend="runtime",
        session_id=str(session_id),
    )

    use_ingress = os.environ.get("USE_INGRESS_GATEWAY", "").lower() in ("1", "true", "yes")
    gateway_url = os.environ.get("INGRESS_GATEWAY_URL", "")
    target = os.environ.get("INGRESS_TARGET_NAME", "recon-agent")
    region = os.environ.get("AWS_REGION", "us-east-1")

    if use_ingress and gateway_url:
        try:
            with traced(
                "dispatch_agent_ingress",
                attributes={
                    "session.id": session_id,
                    "recon.transport": "ingress",
                    "recon.ingress_target": target,
                },
            ):
                # urllib has no botocore event system to hook, so trace headers are passed in
                # explicitly and merged after signing.
                status = invoke_via_ingress(
                    gateway_url=gateway_url,
                    target=target,
                    region=region,
                    payload=payload,
                    session_id=session_id,
                    timeout=_DISPATCH_TIMEOUT_SECONDS,
                    extra_headers=otel_headers(),
                )
            return {"dispatched": True, "statusCode": status, "path": "ingress"}
        except Exception as exc:  # noqa: BLE001 - triaged into timeout vs never-delivered
            if _is_timeout(exc):
                # Do NOT fall back. The dispatch may have landed, in which case an investigation is
                # already running and will signal the token itself; a second dispatch would run a
                # duplicate against the same session. Re-raising fails the Task now, and the state's
                # Catch records it -- which is recoverable, unlike a duplicated LLM run.
                logger.error(
                    "ingress dispatch timed out after %.0fs (%s); NOT falling back, the invocation "
                    "may have landed and a fallback would duplicate the investigation",
                    _DISPATCH_TIMEOUT_SECONDS,
                    exc,
                )
                raise
            logger.warning("ingress dispatch failed (%s); falling back to InvokeAgentRuntime", exc)

    status = _invoke_direct(agent_arn=agent_arn, session_id=session_id, payload=payload)
    return {"dispatched": True, "statusCode": status, "path": "direct"}
