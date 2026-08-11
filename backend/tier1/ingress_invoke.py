"""Invoke the Tier-2 agent THROUGH the AgentCore ingress gateway (SigV4).

The ingress gateway (AWS_IAM inbound auth) fronts the agent runtime via an
``http/agentcoreRuntime`` target. A caller invokes the agent by SigV4-signing a POST to
``{gateway_url}/{target}/invocations`` (service ``bedrock-agentcore``) — the gateway then
proxies to the runtime. Routing agent traffic through this single ingress path (instead of a
direct ``InvokeAgentRuntime``) is what lets a gateway resource policy enforce a controlled,
auditable entry point to the agent.

Uses urllib + botocore SigV4 (both ship with boto3) rather than httpx, so the Tier-1 worker
Lambda needs no extra dependency. The caller's IAM role must be granted
``bedrock-agentcore:InvokeGateway`` on the ingress gateway ARN.
"""

import json
import urllib.request
from typing import Callable, Optional

# Header carrying the AgentCore runtime session id over the gateway HTTP proxy (the
# InvokeAgentRuntime API's runtimeSessionId equivalent) — preserves session continuity/memory.
_SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"


def ingress_invocation_url(gateway_url: str, target: str) -> str:
    """Build the ingress invocation URL for a gateway http/runtime target.

    :param gateway_url: the ingress gateway base host (GetGateway ``gatewayUrl``, no path).
    :param target: the gateway target name fronting the runtime (e.g. ``recon-agent``).
    :returns: ``{gateway_url}/{target}/invocations`` with duplicate slashes collapsed.
    """
    return f"{gateway_url.rstrip('/')}/{target.strip('/')}/invocations"


def signed_headers(
    *, url: str, body: bytes, region: str, session_id: str, creds
) -> dict:
    """SigV4-sign a POST to the ingress gateway and return the request headers.

    :param url: the full invocation URL.
    :param body: the JSON request body (already encoded).
    :param region: AWS region for the signature.
    :param session_id: AgentCore runtime session id (sent as a header, then signed).
    :param creds: botocore credentials (frozen or resolvable) used to sign.
    :returns: a dict of headers including the SigV4 Authorization header.
    """
    # Imported here (not at module top) so unit tests that inject a transport need no botocore.
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    headers = {"Content-Type": "application/json", _SESSION_HEADER: session_id}
    aws_req = AWSRequest(method="POST", url=url, data=body, headers=headers)
    SigV4Auth(creds, "bedrock-agentcore", region).add_auth(aws_req)
    return dict(aws_req.headers)


def invoke_via_ingress(
    *,
    gateway_url: str,
    target: str,
    region: str,
    payload: dict,
    session_id: str,
    creds=None,
    extra_headers: Optional[dict] = None,
    transport: Optional[Callable[[str, bytes, dict], int]] = None,
) -> int:
    """Invoke the agent through the ingress gateway; return the HTTP status code.

    :param gateway_url: ingress gateway base host.
    :param target: gateway target name fronting the runtime.
    :param region: AWS region (for signing).
    :param payload: the invocation payload (e.g. ``{"item": {...}}``).
    :param session_id: stable AgentCore runtime session id.
    :param creds: botocore credentials; resolved from the default session when None.
    :param extra_headers: unsigned headers merged in AFTER signing — used for OTel trace
        propagation (``traceparent``/``baggage``/``X-Amzn-Trace-Id``), which is why they must not
        be part of the canonical request. Keeps this module free of any OTel dependency.
    :param transport: test seam — ``callable(url, body, headers) -> status``; replaces the live
        urllib POST so signing + URL construction are unit-testable without network/AWS.
    :returns: the HTTP status code of the invocation.
    :raises urllib.error.HTTPError: on a non-2xx response from the live transport (fail loudly
        so the worker can fall back to a direct runtime invoke).
    """
    url = ingress_invocation_url(gateway_url, target)
    # Only ever speak HTTPS to the ingress gateway — reject any non-https scheme before signing
    # so a mis-set gateway_url can't turn into a file:// / custom-scheme fetch.
    if not url.lower().startswith("https://"):
        raise ValueError(f"ingress gateway URL must be https, got: {url!r}")
    body = json.dumps(payload).encode()

    if creds is None:
        import boto3

        creds = boto3.Session().get_credentials().get_frozen_credentials()

    headers = signed_headers(
        url=url, body=body, region=region, session_id=session_id, creds=creds
    )
    # Merged after signing on purpose: the SigV4 signature covers only the headers present when
    # add_auth ran, so adding these cannot invalidate it.
    if extra_headers:
        headers.update(extra_headers)

    if transport is not None:
        return transport(url, body, headers)

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    # Scheme asserted https above; urllib avoids an extra Lambda dependency. < Lambda 300s timeout.
    with urllib.request.urlopen(req, timeout=290) as resp:  # noqa: S310  # nosec B310
        return resp.status
