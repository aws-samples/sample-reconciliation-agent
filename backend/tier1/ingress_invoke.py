"""Invoke the Tier-2 agent through the AgentCore ingress gateway, signed with SigV4.

The ingress gateway uses IAM inbound auth and fronts the agent runtime through an
``http/agentcoreRuntime`` target. Invoking the agent means SigV4-signing a POST to
``{gateway_url}/{target}/invocations`` against the ``bedrock-agentcore`` service; the gateway then
proxies it to the runtime. Sending agent traffic through this one path, rather than calling
InvokeAgentRuntime directly, is what gives a gateway resource policy a single controlled and
auditable entry point to enforce.

The transport is urllib plus botocore's SigV4 signer, both of which ship with boto3, instead of
something like httpx. That keeps the Tier-1 worker Lambda free of any extra dependency. The calling
role needs ``bedrock-agentcore:InvokeGateway`` on the gateway ARN.
"""

import json
import urllib.request
from typing import Callable, Optional

# The header that carries the runtime session id across the gateway's HTTP proxy. It is the
# equivalent of the InvokeAgentRuntime API's runtimeSessionId parameter, and it is what preserves
# session continuity, and therefore the agent's memory, on this path.
_SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"


def ingress_invocation_url(gateway_url: str, target: str) -> str:
    """Build the ingress invocation URL for a gateway http/runtime target.

    :param gateway_url: the gateway's base host, as GetGateway reports it in ``gatewayUrl``, with no
        path component.
    :param target: the gateway target name fronting the runtime, e.g. ``recon-agent``.
    :returns: ``{gateway_url}/{target}/invocations``, with duplicate slashes collapsed.
    """
    return f"{gateway_url.rstrip('/')}/{target.strip('/')}/invocations"


def signed_headers(*, url: str, body: bytes, region: str, session_id: str, creds) -> dict:
    """SigV4-sign a POST to the ingress gateway and return the resulting request headers.

    :param url: the full invocation URL.
    :param body: the JSON request body, already encoded.
    :param region: the AWS region the signature is scoped to.
    :param session_id: the runtime session id, set as a header before signing so it is covered by the
        signature.
    :param creds: botocore credentials, frozen or resolvable, used to sign.
    :returns: the headers to send, including the SigV4 Authorization header.
    """
    # Imported inside the function rather than at module top so unit tests that inject their own
    # transport can exercise this module without botocore present.
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
    timeout: float,
    creds=None,
    extra_headers: Optional[dict] = None,
    transport: Optional[Callable[[str, bytes, dict], int]] = None,
) -> int:
    """Invoke the agent through the ingress gateway and return the HTTP status code.

    :param gateway_url: the gateway's base host.
    :param target: the gateway target name fronting the runtime.
    :param region: the AWS region the signature is scoped to.
    :param payload: the invocation payload, e.g. ``{"item": {...}}``.
    :param session_id: a stable runtime session id for this item.
    :param timeout: socket timeout in seconds for the POST. Required, with no default, and that is
        deliberate. This call blocks for the agent's entire investigation, so the only correct value is
        the caller's own remaining execution budget; a default here would be a guess about someone
        else's deadline. The last such guess was a hard-coded 290s, sized against a 300s Lambda
        timeout. The Lambda later moved to 900s and the 290s stayed, so every real investigation
        (700-1100s, measured) timed out here, and the caller's fallback path then started a second one.
    :param extra_headers: headers merged in after signing, and therefore unsigned. This is how OTel
        trace context (``traceparent``, ``baggage``, ``X-Amzn-Trace-Id``) rides along without becoming
        part of the canonical request, and it keeps this module free of any OTel dependency.
    :param transport: a test seam, ``callable(url, body, headers) -> status``, that replaces the live
        urllib POST. Signing and URL construction are then testable with no network and no AWS.
    :returns: the HTTP status code of the invocation.
    :raises urllib.error.HTTPError: on a non-2xx response from the live transport. Failing loudly is
        what lets the worker triage the error and fall back to a direct runtime invoke.
    """
    url = ingress_invocation_url(gateway_url, target)
    # Only ever speak HTTPS to the gateway. The check happens before signing so a mis-set gateway_url
    # cannot turn a signed invocation into a file:// read or some other custom-scheme fetch.
    if not url.lower().startswith("https://"):
        raise ValueError(f"ingress gateway URL must be https, got: {url!r}")
    body = json.dumps(payload).encode()

    if creds is None:
        import boto3

        creds = boto3.Session().get_credentials().get_frozen_credentials()

    headers = signed_headers(url=url, body=body, region=region, session_id=session_id, creds=creds)
    # Merged after signing on purpose. The signature covers only the headers that were present when
    # add_auth ran, so adding these afterwards cannot invalidate it.
    if extra_headers:
        headers.update(extra_headers)

    if transport is not None:
        return transport(url, body, headers)

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    # The scanner suppressions are safe here: the scheme was asserted https above, and urllib is used
    # precisely to avoid adding an HTTP client dependency to this Lambda.
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310  # nosec B310
        return resp.status
