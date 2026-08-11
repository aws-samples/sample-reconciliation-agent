"""Async agent-worker Lambda: makes the blocking agent invocation.

Invoked asynchronously (InvocationType=Event) by the Tier-1 stream consumer so the stream
shard is never blocked for the agent's investigation. The agent persists its own result
(the PROPOSED case), so this worker does not process a response.

Backend selection (``AGENT_BACKEND``) wraps the runtime transport:
  * ``"harness"`` → the managed AgentCore Harness worker (``backend/harness_agent/worker.py``);
  * anything else (default ``"runtime"``) → the container AgentCore Runtime, itself reached via
    one of two transports selected by ``USE_INGRESS_GATEWAY``:
      - ingress gateway (preferred) — SigV4 POST through the AgentCore ingress gateway, so all
        agent traffic flows through one controlled, policy-enforceable entry point;
      - direct ``InvokeAgentRuntime`` — the original path, and the fallback if the ingress path
        fails (so a gateway/policy misconfiguration can never strand escalated items).

The two selectors are orthogonal: AGENT_BACKEND picks runtime-vs-harness; USE_INGRESS_GATEWAY
picks the runtime transport. Flipping AGENT_BACKEND is instant A/B + rollback.
"""

import json
import logging
import os

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
    """Resolve the active agent backend, preferring the runtime SSM switch over the env default.

    The Config tab writes ``AGENT_BACKEND_PARAM`` (SSM) so operators can flip runtime↔harness
    without a redeploy. Falls back to the ``AGENT_BACKEND`` env (Terraform seed), then "runtime".
    Any read failure or unrecognized value degrades to the env/default (fail-safe).
    """
    param = os.environ.get("AGENT_BACKEND_PARAM", "")
    env_default = os.environ.get("AGENT_BACKEND", "runtime").lower()
    if param:
        try:
            val = boto3.client("ssm").get_parameter(Name=param)["Parameter"]["Value"].strip().lower()
            if val in ("runtime", "harness"):
                return val
        except Exception as exc:  # noqa: BLE001 - fall back to the env default on any read error
            logger.warning("agent-backend SSM read failed (%s); using env default: %s", param, exc)
    return env_default


def _invoke_direct(*, agent_arn: str, session_id: str, payload: dict) -> int:
    """Direct InvokeAgentRuntime call (original path / ingress fallback).

    :returns: the runtime invocation's HTTP status code.
    """
    client = boto3.client("bedrock-agentcore")
    # Trace context is not propagated by boto3; the hook writes it onto the signed request.
    register_trace_propagation(client)
    with traced("invoke_agent_runtime", attributes={"gen_ai.agent.arn": agent_arn,
                                                    "session.id": session_id,
                                                    "recon.transport": "direct"}):
        resp = client.invoke_agent_runtime(
            agentRuntimeArn=agent_arn,
            runtimeSessionId=session_id,
            payload=json.dumps(payload).encode(),
        )
        return resp.get("statusCode", 200)


def handle(event, _context):
    """Invoke the recon agent for one escalated item via the configured backend.

    Expects ``{"agent_arn": str, "item": {...}, "session_id": str}`` (built by the Tier-1
    invoker). ``AGENT_BACKEND=="harness"`` routes to the managed harness worker; otherwise the
    container runtime path (ingress gateway with direct-invoke fallback). Returns the outcome +
    which path served it (for observability).
    """
    backend = _resolve_backend()

    # Caller-known context → W3C baggage, set ONCE for the whole invocation so it rides every
    # downstream call (harness or runtime) and AgentCore can promote the allow-listed keys onto
    # the agent's own spans. Set before dispatch so the harness path inherits it too.
    item = event.get("item") or {}
    set_recon_baggage(
        item_id=str(item.get("item_id", "")),
        domain=str(item.get("domain", "")),
        backend=backend,
        session_id=str(event.get("session_id", "")),
    )

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
        try:
            with traced("invoke_agent_ingress", attributes={"session.id": session_id,
                                                            "recon.transport": "ingress",
                                                            "recon.ingress_target": target}):
                # urllib path: no botocore event system to hook, so the headers are passed in
                # explicitly and merged after signing (same effect as the before-send hook).
                status = invoke_via_ingress(
                    gateway_url=gateway_url,
                    target=target,
                    region=region,
                    payload=payload,
                    session_id=session_id,
                    extra_headers=otel_headers(),
                )
            return {"statusCode": status, "path": "ingress"}
        except Exception as exc:  # noqa: BLE001 - never strand an item; fall back to direct.
            logger.warning(
                "ingress-gateway invoke failed (%s); falling back to InvokeAgentRuntime", exc
            )

    status = _invoke_direct(agent_arn=agent_arn, session_id=session_id, payload=payload)
    return {"statusCode": status, "path": "direct"}
