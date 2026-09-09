#!/usr/bin/env python3
"""Dump the AgentCore Gateway's live MCP tool surface (`tools/list`).

This is the ONLY reliable check that a connector target's `parameterOverrides` took effect. An
unrecognised `ParameterOverrides[].Path` is silently ignored by CreateGatewayTarget: the target
still reaches READY, the tool is still advertised, and the override simply never appears in the
tool's inputSchema. Retrieval then runs unfiltered and returns HTTP 200. Nothing errors anywhere,
so target status cannot be the gate -- the generated inputSchema is.

It is also how you learn the tool's real JSON-Schema property names. How a `Path` maps to a
property name is undocumented, and the Python wrapper's argument keys must match those names
exactly, so they have to be read off the live surface rather than inferred from the Path strings.

Usage:
    python3 scripts/mcp_tools_list.py --gateway-url https://<id>.gateway.bedrock-agentcore.\
us-east-1.amazonaws.com
    python3 scripts/mcp_tools_list.py --tool managed-kb___Retrieve      # full schema for one tool
    python3 scripts/mcp_tools_list.py --names                           # just the tool names

The gateway's inbound auth is AWS_IAM, so the request is SigV4-signed for service
`bedrock-agentcore` with whatever credentials the caller's profile resolves to. The caller must be
permitted by the gateway's resource policy AND by the AgentCore Policy engine's Cedar policies.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

import botocore.session
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

MCP_SERVICE = "bedrock-agentcore"


GATEWAY_STATE_ADDRESS = "module.recon_agent.aws_bedrockagentcore_gateway.this"


def resolve_gateway_url(*, terraform_dir: str) -> str:
    """Read the egress gateway URL out of the Terraform state.

    The environment exposes no gateway-URL output, so this reads the resource's state directly.
    That needs an initialised backend (and therefore valid credentials); pass --gateway-url to
    skip it.

    Args:
        terraform_dir: Directory holding the initialised Terraform environment.

    Returns:
        The gateway URL string.

    Raises:
        RuntimeError: If the address is absent or carries no gateway_url. Guessing the URL would
            send a signed request to the wrong host, so this fails loudly instead.
    """
    result = subprocess.run(
        ["terraform", f"-chdir={terraform_dir}", "state", "show", "-no-color", GATEWAY_STATE_ADDRESS],
        capture_output=True,
        text=True,
        check=False,
    )
    match = re.search(r'^\s*gateway_url\s*=\s*"([^"]+)"', result.stdout, flags=re.MULTILINE)
    if result.returncode != 0 or match is None:
        raise RuntimeError(
            f"could not read gateway_url from {GATEWAY_STATE_ADDRESS} in {terraform_dir}: "
            f"exit={result.returncode} stderr={result.stderr.strip()!r}. "
            "Pass --gateway-url explicitly."
        )
    return match.group(1)


def mcp_endpoint(*, gateway_url: str) -> str:
    """Turn a bare gateway URL into its MCP streamable-HTTP endpoint.

    GetGateway returns the host without a path; the MCP transport lives at /mcp.

    Args:
        gateway_url: Gateway URL as reported by GetGateway or Terraform.

    Returns:
        The URL of the /mcp endpoint.
    """
    base = gateway_url.rstrip("/")
    return base if base.endswith("/mcp") else f"{base}/mcp"


def mcp_request(
    *,
    gateway_url: str,
    method: str,
    params: dict,
    region: str,
    profile: str | None,
) -> dict:
    """Make one SigV4-signed JSON-RPC call to the gateway's MCP endpoint.

    Args:
        gateway_url: Gateway URL (with or without the /mcp suffix).
        method: JSON-RPC method name, e.g. "tools/list".
        params: JSON-RPC params object.
        region: AWS region of the gateway.
        profile: AWS profile to sign with, or None for the default chain.

    Returns:
        The JSON-RPC `result` object.

    Raises:
        RuntimeError: On a transport error, an unparseable body, or a JSON-RPC `error` member.
    """
    url = mcp_endpoint(gateway_url=gateway_url)
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})

    session = botocore.session.Session(profile=profile)
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError(f"no AWS credentials resolved for profile={profile!r}")

    request = AWSRequest(
        method="POST",
        url=url,
        data=body.encode(),
        headers={
            "content-type": "application/json",
            # The streamable-HTTP transport requires BOTH accept types; with only
            # application/json the gateway answers 406.
            "accept": "application/json, text/event-stream",
        },
    )
    SigV4Auth(credentials.get_frozen_credentials(), MCP_SERVICE, region).add_auth(request)

    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed https gateway endpoint
            urllib.request.Request(url, data=body.encode(), headers=dict(request.headers)),
            timeout=60,
        ) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"{method} -> HTTP {error.code}: {error.read().decode()[:2000]}"
        ) from error

    payload = _parse_body(raw=raw)
    if "error" in payload:
        raise RuntimeError(f"{method} -> JSON-RPC error: {payload['error']}")
    if "result" not in payload:
        raise RuntimeError(f"{method} -> response has no result member: {raw[:2000]}")
    return payload["result"]


def _parse_body(*, raw: str) -> dict:
    """Parse a response body that may be plain JSON or a text/event-stream frame.

    The gateway picks the encoding itself, so both shapes have to be handled. An SSE body is a
    sequence of `data: <json>` lines; the last one carries the response.

    Args:
        raw: The raw response body.

    Returns:
        The decoded JSON-RPC envelope.

    Raises:
        RuntimeError: If no JSON object could be recovered.
    """
    stripped = raw.strip()
    if stripped.startswith("{"):
        return json.loads(stripped)

    frames = [
        line[len("data:") :].strip()
        for line in stripped.splitlines()
        if line.startswith("data:")
    ]
    if not frames:
        raise RuntimeError(f"body is neither JSON nor an SSE stream: {raw[:2000]}")
    return json.loads(frames[-1])


def main() -> int:
    """Print the gateway's tool surface, or one tool's full inputSchema.

    Returns:
        Process exit code: 0 on success, 1 when --tool names a tool the gateway does not
        advertise (which is the failure mode this script exists to catch).
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default=None, help="Gateway URL; default: read from Terraform.")
    parser.add_argument("--terraform-dir", default="infra/environments/recon")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default=None, help="AWS profile; default: credential chain.")
    parser.add_argument("--tool", default=None, help="Print only this tool, with its full inputSchema.")
    parser.add_argument("--names", action="store_true", help="Print tool names only.")
    args = parser.parse_args()

    gateway_url = args.gateway_url or resolve_gateway_url(terraform_dir=args.terraform_dir)

    result = mcp_request(
        gateway_url=gateway_url,
        method="tools/list",
        params={},
        region=args.region,
        profile=args.profile,
    )
    tools = result.get("tools", [])

    if args.tool:
        matches = [tool for tool in tools if tool.get("name") == args.tool]
        if not matches:
            print(
                f"tool {args.tool!r} is NOT advertised by the gateway. Advertised: "
                f"{sorted(tool.get('name', '?') for tool in tools)}",
                file=sys.stderr,
            )
            return 1
        print(json.dumps(matches[0], indent=2, sort_keys=True))
        return 0

    if args.names:
        for name in sorted(tool.get("name", "?") for tool in tools):
            print(name)
        return 0

    # Default: one line per tool with its top-level input property names -- enough to see at a
    # glance whether an override landed, without burying it in full schemas.
    for tool in sorted(tools, key=lambda t: t.get("name", "")):
        properties = sorted((tool.get("inputSchema") or {}).get("properties", {}))
        required = sorted((tool.get("inputSchema") or {}).get("required", []))
        print(f"{tool.get('name')}")
        print(f"    properties: {properties}")
        print(f"    required:   {required}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
