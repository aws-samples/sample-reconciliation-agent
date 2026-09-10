"""Async agent-worker Lambda: makes the blocking agent invocation.

The Tier-1 stream consumer invokes this with InvocationType=Event, so no stream shard is held
open for the minutes an investigation takes. The agent persists its own result (the PROPOSED
case), which is why nothing here reads a response.

Two independent switches decide how the agent gets reached.

``AGENT_BACKEND`` picks who runs the investigation. Set it to "harness" and the managed AgentCore
Harness runs it; anything else (default "runtime") uses our own AgentCore Runtime container.
Flipping it is an instant A/B, and an instant rollback.

``USE_INGRESS_GATEWAY`` picks how that container is reached, and applies only to the runtime
backend. When it is on, the worker SigV4-signs a POST through the AgentCore ingress gateway, so
every agent invocation passes through one entry point a gateway resource policy can control and
audit. When it is off, or when the gateway path fails for any reason other than a timeout, the
worker calls InvokeAgentRuntime directly instead. That fallback exists so a misconfigured gateway
or policy cannot strand escalated items with nowhere to go.
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


def _resolve_backend() -> str:
    """Resolve the active agent backend, preferring the SSM switch over the deployed default.

    The Config UI writes the SSM parameter named by ``AGENT_BACKEND_PARAM``, which is how an
    operator moves traffic between the runtime and the harness without a redeploy. If that
    parameter is unset, unreadable, or holds anything other than "runtime" or "harness", the
    ``AGENT_BACKEND`` environment value wins, and "runtime" if that is unset too.

    Degrading to the deployed default is the deliberate choice here, and it is the one exception
    to this package's fail-loudly rule: an unreadable toggle should not stop items from being
    investigated at all. The read failure is logged so it does not pass unnoticed.

    :returns: either "runtime" or "harness".
    """
    param = os.environ.get("AGENT_BACKEND_PARAM", "")
    env_default = os.environ.get("AGENT_BACKEND", "runtime").lower()
    if param:
        try:
            val = (
                boto3.client("ssm").get_parameter(Name=param)["Parameter"]["Value"].strip().lower()
            )
            if val in ("runtime", "harness"):
                return val
        except Exception as exc:  # noqa: BLE001 - see the docstring: degrade to the env default.
            logger.warning("agent-backend SSM read failed (%s); using env default: %s", param, exc)
    return env_default


# Seconds held back from the Lambda's remaining budget so a timeout surfaces as our own error, with
# a log line naming the item. Spend the whole budget and the Lambda service kills the container
# mid-call instead, leaving a bare "Task timed out" with no item id in it to trace.
_BUDGET_RESERVE_SECONDS = 20.0


def _is_timeout(exc: BaseException) -> bool:
    """Is this a request timeout, meaning the agent is still running, or a delivery failure?

    Two callers depend on the answer and both get it wrong in the same expensive way if it is
    wrong. A timeout means the request was delivered and the investigation is still executing, so
    neither retrying nor marking the case FAILED is honest: the run in flight will persist its own
    outcome. Anything else means nothing is in flight, so re-driving costs nothing.

    A read-phase timeout arrives as ``TimeoutError`` (``socket.timeout`` has been an alias for it
    since Python 3.10). A connect-phase one arrives wrapped in ``URLError``, with the original
    stored on ``reason``, which is what the second check unwraps.

    :param exc: the exception raised by the invocation.
    :returns: True if it represents a timeout.
    """
    if isinstance(exc, TimeoutError):
        return True
    # An HTTPError cannot reach the second branch even though it subclasses URLError, because its
    # `reason` is a string rather than a TimeoutError. That is the behaviour we want: a status code
    # means the gateway answered, which is a delivery outcome and not a timeout.
    return isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, TimeoutError)


def _remaining_budget_seconds(context) -> float:
    """Seconds this invocation may still spend blocking on the agent, minus a reporting reserve.

    Read from the live Lambda context rather than written down as a constant, because a constant is
    only correct until someone changes the function timeout it was matched to. The last one was
    290s against a 300s timeout; the timeout later became 900s and the 290s stayed, quietly turning
    into a three-fold under-estimate that expired every real investigation.

    :param context: the Lambda context object; must supply ``get_remaining_time_in_millis``.
    :returns: the usable budget in seconds, never below 1.0.
    :raises AttributeError: if ``context`` is not a Lambda context. The budget has to come from the
        real deadline, so there is deliberately no default to fall back to.
    """
    remaining = context.get_remaining_time_in_millis() / 1000.0
    return max(1.0, remaining - _BUDGET_RESERVE_SECONDS)


def _invoke_direct(*, agent_arn: str, session_id: str, payload: dict, timeout: float) -> int:
    """Call InvokeAgentRuntime directly, bypassing the ingress gateway.

    :param agent_arn: the AgentCore runtime ARN to invoke.
    :param session_id: stable AgentCore runtime session id.
    :param payload: the invocation payload, e.g. ``{"item": {...}}``.
    :param timeout: read timeout in seconds. The call blocks for the whole investigation.
    :returns: the runtime invocation's HTTP status code.
    """
    from botocore.config import Config

    # max_attempts=1 means no retry at all, and it is the load-bearing setting in this function.
    # botocore retries a ReadTimeoutError by default, but for this API a read timeout does not mean
    # the request failed: the investigation is still running server-side. So the retry does not
    # recover the first run, it starts a second multi-minute LLM investigation alongside it.
    client = boto3.client(
        "bedrock-agentcore",
        config=Config(
            connect_timeout=10,
            read_timeout=timeout,
            retries={"max_attempts": 1, "mode": "standard"},
        ),
    )
    # boto3 does not propagate trace context on its own, so this registers a hook that writes it
    # onto the signed request.
    register_trace_propagation(client)
    with traced(
        "invoke_agent_runtime",
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


def _record_failure(*, item_id: str, reason: str) -> None:
    """Escalate the case to FAILED so a dead investigation is visible and retryable.

    This writes to the case table directly instead of going through the ``recon_update_status``
    gateway tool, and that is on purpose. The Cedar policy grants that tool to the frontend's
    backend role and explicitly denies it to the agent and worker roles, so the model can never
    move its own case. FAILED is a verdict about the run rather than a claim about the item, so the
    platform is the right author for it.

    Nothing here raises. The caller is about to re-raise the real error, and replacing that with a
    DynamoDB error would throw away the diagnosis. A failure at this point is logged at ERROR
    instead, so it stays visible without displacing the thing that actually went wrong.

    :param item_id: the case key of the item whose investigation died.
    :param reason: human-readable cause, stored on the case for the analyst.
    :returns: None
    """
    if not item_id:
        logger.error("cannot mark a case FAILED: the event carried no item_id")
        return
    try:
        from backend.recon_core.cases import CaseStore

        cases = CaseStore(
            table=os.environ.get("CASES_TABLE", "recon-cases"),
            audit=os.environ.get("AUDIT_TABLE", "recon-audit"),
        )
        if cases.mark_failed(item_id, reason=reason):
            logger.error("case %s marked FAILED: %s", item_id, reason)
        else:
            # The case is no longer IN_PROGRESS, so the run persisted a proposal, or an analyst
            # moved the case, before it errored on the way out. That result outranks the error;
            # leaving it alone is the outcome we want.
            logger.warning(
                "case %s not marked FAILED (status no longer IN_PROGRESS); original error: %s",
                item_id,
                reason,
            )
    except Exception as exc:  # noqa: BLE001 - see the docstring: must not mask the original error.
        logger.error("failed to mark case %s FAILED (%s); original error: %s", item_id, exc, reason)


def handle(event, _context):
    """Invoke the recon agent for one escalated item, marking the case FAILED if the run dies.

    All the real work happens in ``_dispatch``; this wrapper exists to make a dead run visible.
    Only the agent writes the PROPOSED row, so any non-timeout exception escaping dispatch means no
    result is ever coming. Without this wrapper such an item sits in IN_PROGRESS forever and an
    analyst cannot tell "still thinking" from "died forty minutes ago".

    Timeouts are exempt, and that exemption matters more than the guard itself. A timeout means the
    investigation is still executing server-side and will persist its own outcome, so FAILED would
    be a false verdict, and the retry it invites would run a second copy of a live investigation.
    The ingress path refuses to fall back on a timeout for the same reason.

    :param event: ``{"agent_arn": str, "item": {...}, "session_id": str}``.
    :param _context: the Lambda context, used for the invocation's time budget.
    :returns: whatever ``_dispatch`` returns.
    :raises Exception: re-raises the dispatch failure after recording it, so the invocation still
        counts as an error in Lambda's own metrics.
    """
    item_id = str((event.get("item") or {}).get("item_id", ""))
    try:
        result = _dispatch(event, _context)
    except Exception as exc:
        if not _is_timeout(exc):
            _record_failure(item_id=item_id, reason=f"{type(exc).__name__}: {exc}")
        raise
    # Today both transports raise on an error status: urllib on anything >= 400, botocore on a
    # runtime error. So this branch is belt-and-braces. It is here because a failing status that
    # arrives as a return value instead of an exception strands the case in exactly the same way,
    # and that is the hole worth closing rather than the one already covered above.
    status = result.get("statusCode") if isinstance(result, dict) else None
    if status is not None and int(status) >= 400:
        _record_failure(item_id=item_id, reason=f"agent invocation returned HTTP {status}")
    return result


def _dispatch(event, _context):
    """Invoke the recon agent for one escalated item via the configured backend.

    Expects ``{"agent_arn": str, "item": {...}, "session_id": str}`` from the Tier-1 dispatcher and
    forwards it unchanged, because the deterministic ``tier1_*`` keys are already on the item and
    rebuilding the payload per backend is how one of them would get dropped. A backend of "harness"
    routes to the managed harness worker; anything else takes the container runtime path, meaning
    the ingress gateway with a direct-invoke fallback.

    :param event: the invocation payload described above.
    :param _context: the Lambda context, used for the invocation's time budget.
    :returns: the invocation outcome plus a ``path`` naming which transport served it, so the two
        backends and two transports stay distinguishable in logs and traces.
    """
    backend = _resolve_backend()

    # Everything the caller already knows goes into W3C baggage once, here, rather than per call.
    # It then rides every downstream request on either backend, and AgentCore can promote the
    # allow-listed keys onto the agent's own spans. Setting it before dispatch is what lets the
    # harness path inherit it too.
    item = event.get("item") or {}
    set_recon_baggage(
        item_id=str(item.get("item_id", "")),
        domain=str(item.get("domain", "")),
        backend=backend,
        session_id=str(event.get("session_id", "")),
    )

    # No classification happens in this worker. The stream consumer stamped `tier1_break_type` and
    # `tier1_escalation_reason` onto the item before it opened the case, so forwarding the payload
    # unchanged is all it takes for either backend to receive them.
    if backend == "harness":
        from backend.harness_agent.worker import handle as harness_handle

        result = harness_handle(event, _context)
        return {"path": "harness", **(result if isinstance(result, dict) else {"result": result})}

    agent_arn = event["agent_arn"]
    session_id = event["session_id"]
    payload = {"item": event["item"]}

    use_ingress = os.environ.get("USE_INGRESS_GATEWAY", "").lower() in ("1", "true", "yes")
    gateway_url = os.environ.get("INGRESS_GATEWAY_URL", "")
    target = os.environ.get("INGRESS_TARGET_NAME", "recon-agent")
    region = os.environ.get("AWS_REGION", "us-east-1")

    if use_ingress and gateway_url:
        budget = _remaining_budget_seconds(_context)
        try:
            with traced(
                "invoke_agent_ingress",
                attributes={
                    "session.id": session_id,
                    "recon.transport": "ingress",
                    "recon.ingress_target": target,
                },
            ):
                # This path is urllib, which has no botocore event system to hook, so the trace
                # headers are passed in explicitly and merged after signing. Same effect as the
                # before-send hook the direct path registers.
                status = invoke_via_ingress(
                    gateway_url=gateway_url,
                    target=target,
                    region=region,
                    payload=payload,
                    session_id=session_id,
                    timeout=budget,
                    extra_headers=otel_headers(),
                )
            return {"statusCode": status, "path": "ingress"}
        except Exception as exc:  # noqa: BLE001 - triaged below into timeout vs never-delivered.
            if _is_timeout(exc):
                # A timeout is not a delivery failure. The gateway forwarded the request and the
                # agent is still investigating, so falling back here starts a second full
                # investigation of the same item. That is not hypothetical: with a deadline short
                # enough that every run times out, the fallbacks plus Lambda's own async retries
                # stack up to seven concurrent investigations of one item. Re-raising instead leaves
                # the outcome to the run already in flight, which writes its own case row, and keeps
                # the timeout visible rather than papered over by a duplicate that looks like a
                # recovery.
                logger.error(
                    "ingress-gateway invoke timed out after %.0fs (%s); the runtime invocation is "
                    "still in flight and will persist its own result — NOT falling back, a fallback "
                    "would duplicate the investigation",
                    budget,
                    exc,
                )
                raise
            # Everything else is evidence the request never ran at all: a signing or URL error, or
            # an HTTP status from the gateway. None of those leaves anything in flight, so a direct
            # invoke has nothing to duplicate.
            logger.warning(
                "ingress-gateway invoke failed (%s); falling back to InvokeAgentRuntime", exc
            )

    status = _invoke_direct(
        agent_arn=agent_arn,
        session_id=session_id,
        payload=payload,
        timeout=_remaining_budget_seconds(_context),
    )
    return {"statusCode": status, "path": "direct"}
