"""Shared SigV4 MCP client for calling egress-gateway tools from platform code.

Any backend component that needs to invoke a gateway tool (resolution email, the
recon-status workflow tool, the Policy-gated ledger write) uses ``call_gateway_tool`` so
every platform tool call goes through the same transport: a JSON-RPC ``tools/call`` POST to
``<gateway_url>/mcp``, SigV4-signed for service ``bedrock-agentcore`` (the gateway's inbound
auth is AWS_IAM). Implemented with stdlib ``urllib`` + ``botocore`` so Lambda-packaged
callers need no ``mcp``/``httpx`` dependency.

Routing through the gateway (instead of invoking tool Lambdas directly) is what makes the
AgentCore Policy engine and the gateway REQUEST interceptor apply to platform callers the
same way they apply to the agent.
"""

import json
import os
import urllib.request
from typing import Callable, Optional

# Transport signature shared by production and tests: (tool_name, arguments) -> result dict.
GatewayTransport = Callable[[str, dict], dict]


def mcp_endpoint(gateway_url: str) -> str:
    """Return the MCP streamable-HTTP endpoint for a gateway URL (idempotent ``/mcp`` suffix).

    :param gateway_url: bare gateway host URL (as returned by ``GetGateway``) or an
        already-suffixed ``…/mcp`` URL.
    :returns: the ``…/mcp`` endpoint URL.
    """
    trimmed = gateway_url.rstrip("/")
    return trimmed if trimmed.endswith("/mcp") else f"{trimmed}/mcp"


def call_gateway_tool(
    tool_name: str,
    arguments: dict,
    *,
    gateway_url: Optional[str] = None,
    region: Optional[str] = None,
    transport: Optional[GatewayTransport] = None,
) -> dict:
    """SigV4-signed MCP ``tools/call`` against the egress gateway. Raises on any failure.

    :param tool_name: full gateway MCP tool name (``{target}___{operation}``).
    :param arguments: the tool's arguments object.
    :param gateway_url: gateway URL; defaults to the ``RECON_GATEWAY_URL`` env var.
    :param region: AWS region for SigV4; defaults to ``AWS_REGION`` env var (us-east-1).
    :param transport: test seam — ``callable(tool_name, arguments) -> result`` replacing the
        live SigV4 round-trip. Production leaves it None.
    :returns: the parsed JSON-RPC ``result`` object.
    :raises RuntimeError: when the gateway or the tool reports an error (including a Policy
        denial or an interceptor rejection).
    """
    if transport is not None:
        return transport(tool_name, arguments)

    import boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    url = mcp_endpoint(gateway_url or os.environ["RECON_GATEWAY_URL"])
    sig_region = region or os.environ.get("AWS_REGION", "us-east-1")

    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }).encode()
    headers = {
        "Content-Type": "application/json",
        # The gateway's streamable-HTTP transport requires both accept types.
        "Accept": "application/json, text/event-stream",
    }
    aws_req = AWSRequest(method="POST", url=url, data=body, headers=headers)
    creds = boto3.Session().get_credentials()
    SigV4Auth(creds, "bedrock-agentcore", sig_region).add_auth(aws_req)

    # Only ever speak HTTPS to the gateway — reject any non-https scheme before opening the
    # request so a mis-set RECON_GATEWAY_URL can't turn into a file:// / custom-scheme fetch.
    if not url.lower().startswith("https://"):
        raise ValueError(f"gateway URL must be https, got: {url!r}")

    req = urllib.request.Request(url, data=body, headers=dict(aws_req.headers), method="POST")
    # Scheme asserted https above; urllib avoids an httpx dependency in Lambda-packaged callers.
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310  # nosec B310
        raw = resp.read().decode()

    # Streamable-HTTP may answer as SSE ("data: {...}" lines) or plain JSON — parse either.
    payload = None
    for line in raw.splitlines():
        if line.startswith("data:"):
            payload = json.loads(line[len("data:"):].strip())
            break
    if payload is None:
        payload = json.loads(raw)

    if payload.get("error"):
        raise RuntimeError(f"gateway tools/call failed: {payload['error']}")
    result = payload.get("result", {})
    if result.get("isError"):
        raise RuntimeError(f"{tool_name} failed: {json.dumps(result.get('content'))}")
    return result
