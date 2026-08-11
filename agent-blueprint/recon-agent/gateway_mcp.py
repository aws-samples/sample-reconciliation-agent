"""Gateway MCP transport — the agent calls its tools THROUGH the egress tools gateway.

Every tool call (reads and the set_draw_status write) goes over MCP to the egress gateway,
SigV4-signed with the runtime's execution role (the gateway's inbound auth is AWS_IAM). Routing
through the gateway is what lets AgentCore Policy intercept and gate each call — a direct Lambda
invoke would bypass the policy engine entirely, so this transport is required, not optional.

The mailbox READ routes through the existing microsoft-graph OpenAPI target: the short name
``search_correspondence`` maps to ``microsoft-graph___listSharedMailboxMessages``. That short name
exists because the raw op is not model-safe as the gateway advertises it (``$``-prefixed OData
argument names) — ``strands_investigator`` wraps it and calls the short name.

There is no send short name. Nothing the agent can reach through this transport sends mail: a
counterparty email is data on the proposal, and the send is made later by the BFF from the revision
a human approved.

The model emits short tool names (``search_ledger``); the gateway exposes them prefixed by
target (``general-ledger___search_ledger``, three underscores). ``gateway_tool_name`` maps
between them.
"""

import asyncio
import json
from typing import Callable

# ToolDenied lives in backend.recon_core.errors so Lambda-packaged code (auto_resolve, the
# harness worker) can import it without depending on this container-only module. Re-exported
# here so `from gateway_mcp import ToolDenied` keeps working for the container + existing tests.
from backend.recon_core.errors import ToolDenied  # noqa: F401

# Short tool name (what the model/agent uses) -> gateway MCP tool name ({target}___{tool}).
GATEWAY_TOOL_NAMES = {
    "search_ledger": "general-ledger___search_ledger",
    "search_guidance": "knowledge-base___search_guidance",
    # IDP's MCP server nests its tools under the `IDPTools` group, so the gateway tool name is
    # document-extraction___IDPTools___get_results (NOT ___get_results — that name doesn't exist
    # and the MCP call fails with an opaque "unhandled errors in a TaskGroup").
    "get_results": "document-extraction___IDPTools___get_results",
    "set_draw_status": "set-draw-status___set_draw_status",
    # Mailbox read routes through the existing microsoft-graph OpenAPI target.
    "search_correspondence": "microsoft-graph___listSharedMailboxMessages",
    # NOTE: no send entry. The Graph send op exists on the gateway, but no short name maps to it
    # here, so an agent tool cannot reach it even by accident. Sending is the platform's act, on a
    # draft a human approved (backend/cases/notify.py and the BFF hold that path).
}


def gateway_tool_name(short: str) -> str:
    """Map a short tool name to its gateway MCP name (pass through if unknown)."""
    return GATEWAY_TOOL_NAMES.get(short, short)


def parse_tool_result(res) -> dict:
    """Extract the tool payload from an MCP CallToolResult, matching the harness's behavior.

    The live AgentCore gateway returns tool output as ``content`` TEXT parts (the JSON payload,
    sometimes chunked across several parts) and only populates ``structuredContent`` when the
    tool declares an ``outputSchema`` — which the recon Lambda targets do NOT. The previous code
    returned ``res.structuredContent or {}``, silently discarding the real data in ``content``
    and handing the agent ``{}`` for every read (search_ledger/search_guidance/get_results). The
    managed harness client reads ``content`` (see backend/harness_agent/intake.py), so the two
    backends disagreed on the SAME gateway call. This makes the runtime read ``content`` too.

    Precedence: ``structuredContent`` when present (proper MCP path if a schema is ever added),
    else the concatenated ``content`` text parts parsed as JSON, else an empty dict.

    :param res: an MCP ``CallToolResult`` (or compatible object with ``structuredContent`` /
        ``content`` attributes).
    :returns: the tool's payload as a dict (``{}`` when genuinely empty/unparseable).
    """
    structured = getattr(res, "structuredContent", None)
    if structured:
        return structured

    # Concatenate all text content parts (live results chunk one JSON payload across parts).
    text_chunks: list[str] = []
    for part in getattr(res, "content", None) or []:
        text = getattr(part, "text", None)
        if text is not None:
            text_chunks.append(str(text))
    if not text_chunks:
        return {}
    blob = "".join(text_chunks).strip()
    try:
        parsed = json.loads(blob)
    except (ValueError, TypeError):
        # Non-JSON text (unexpected for these tools) — surface it rather than silently drop.
        return {"result": blob}
    # Tools return an object ({"rows": [...]}); wrap a bare list/scalar so callers get a dict.
    return parsed if isinstance(parsed, dict) else {"result": parsed}


def mcp_endpoint(gateway_url: str) -> str:
    """Return the MCP streamable-HTTP endpoint for a gateway URL.

    The control-plane ``GetGateway`` returns the bare host
    (``https://<id>.gateway.bedrock-agentcore.<region>.amazonaws.com``, no path). The MCP
    streamable-HTTP transport lives at that host + ``/mcp`` — POSTing to the bare host hits the
    data-plane RPC endpoint, which replies with an AWS ``{"Output":..., "Version":"1.0"}`` error
    envelope that the MCP client cannot parse. Idempotent: an already-suffixed URL is unchanged.
    """
    trimmed = gateway_url.rstrip("/")
    return trimmed if trimmed.endswith("/mcp") else f"{trimmed}/mcp"


def _run_sync(coro):
    """Drive an async coroutine to completion from a synchronous caller.

    The agent's ``@app.entrypoint handler`` is ``async def``, so it runs inside a live event
    loop. Calling ``asyncio.run(coro)`` from there raises ``RuntimeError: asyncio.run() cannot
    be called from a running event loop`` — which was being swallowed into an ``{"error": ...}``
    dict while leaving the coroutine un-awaited (the "coroutine was never awaited" warning). To
    keep the tool caller SYNCHRONOUS (llm.py / auto_resolve.py call it as a plain function), run
    the coroutine in a dedicated worker thread with its own loop when a loop is already running.

    :param coro: the coroutine object to execute.
    :returns: the coroutine's result (exceptions propagate to the caller unchanged).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No loop running in this thread — safe to drive one directly.
        return asyncio.run(coro)
    # A loop is already running (async handler): offload to a worker thread with its own loop.
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _root_error(exc: BaseException) -> str:
    """Flatten an anyio ``ExceptionGroup`` to its real leaf error text.

    MCP tool calls run inside an anyio task group, so a transport/tool failure surfaces to the
    caller as an opaque ``ExceptionGroup`` whose ``str()`` is just "unhandled errors in a TaskGroup
    (1 sub-exception)" — useless in the agent trace. This recurses into ``.exceptions`` and returns
    the underlying leaf message(s) so the recorded ``tool_output`` names the actual cause.
    """
    subs = getattr(exc, "exceptions", None)
    if subs:
        return "; ".join(_root_error(e) for e in subs)
    msg = str(exc).strip()
    return f"{type(exc).__name__}: {msg}" if msg else type(exc).__name__


def _has_leaf(exc: BaseException, cls: type) -> bool:
    """True if ``exc`` (or any nested ExceptionGroup leaf) is an instance of ``cls``."""
    subs = getattr(exc, "exceptions", None)
    if subs:
        return any(_has_leaf(e, cls) for e in subs)
    return isinstance(exc, cls)


# Substrings that identify a denial (Policy/interceptor/IAM) in a flattened leaf message.
_DENIAL_MARKERS = ("accessdenied", "403", "denied", "not authorized", "unauthorized")


def classify_transport_error(exc: BaseException) -> Exception:
    """Convert a raw MCP transport failure into the exception the caller should see.

    Every tool failure arrives here wrapped: MCP runs the call inside an anyio task group, and
    anyio 4 (``strict_exception_groups=True`` by default) rewraps even a SINGLE exception into a
    ``BaseExceptionGroup`` whose ``str()`` is only "unhandled errors in a TaskGroup (1
    sub-exception)". So both the message and the denial/failure decision must come from the
    flattened LEAVES, never from ``str(exc)`` of the group.

    :param exc: the exception raised by the MCP round-trip (usually an ``ExceptionGroup``).
    :returns: ``ToolDenied`` when any leaf is a ``ToolDenied`` or reads as a denial (so
        ``auto_resolve`` escalates instead of crashing), else ``RuntimeError`` — both carrying the
        unwrapped leaf message.
    """
    msg = _root_error(exc)
    if _has_leaf(exc, ToolDenied) or any(s in msg.lower() for s in _DENIAL_MARKERS):
        return ToolDenied(msg)
    return RuntimeError(msg)


def make_gateway_tool_caller(
    *, gateway_url: str, region: str, session_factory: Callable | None = None
) -> Callable:
    """Build a ``tool_caller(short_name, args) -> result`` that calls tools via the gateway.

    :param gateway_url: the egress gateway MCP endpoint.
    :param region: AWS region (for SigV4 signing).
    :param session_factory: test seam — ``callable(tool_name, args) -> result``. When provided,
        it replaces the live MCP+SigV4 round-trip so the mapping and caller contract are unit
        testable without AWS. Production leaves it None.
    :returns: a synchronous tool caller (wraps the async MCP call per invocation).
    """

    def _call(short_name: str, args: dict):
        tool = gateway_tool_name(short_name)
        if session_factory is not None:
            return session_factory(tool, args)
        # _run_sync handles the async-handler case (a running event loop) — see its docstring.
        try:
            return _run_sync(_mcp_call(gateway_url, region, tool, args))  # pragma: no cover
        except ToolDenied:
            raise
        except Exception as exc:  # noqa: BLE001 - re-raise with the unwrapped leaf error
            # Deliberately Exception, not BaseException: an anyio group holding a CancelledError
            # leaf is a bare BaseExceptionGroup, and cancellation must propagate untouched rather
            # than be relabelled as a tool failure.
            raise classify_transport_error(exc) from exc

    return _call


def _sigv4_auth(region: str):  # pragma: no cover - thin botocore/httpx signing glue
    """Return an httpx auth that SigV4-signs each request to the gateway (bedrock-agentcore)."""
    import boto3
    import httpx
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = boto3.Session()
    creds = session.get_credentials()

    class _Sig(httpx.Auth):
        requires_request_body = True

        def auth_flow(self, request):
            aws_req = AWSRequest(
                method=request.method,
                url=str(request.url),
                data=request.content,
                headers={"Content-Type": request.headers.get("Content-Type", "application/json")},
            )
            SigV4Auth(creds, "bedrock-agentcore", region).add_auth(aws_req)
            for k, v in aws_req.headers.items():
                request.headers[k] = v
            yield request

    return _Sig()


async def _mcp_call(gateway_url: str, region: str, tool: str, args: dict):  # pragma: no cover
    """Open a SigV4-signed MCP session to the gateway and call one tool.

    Raises ToolDenied when the gateway/policy rejects the call (surfaced to the caller as an
    escalation). NOTE: the live SigV4-over-MCP round-trip is validated at deploy (G8); the
    tool-name mapping and caller contract are unit-tested via ``session_factory``.

    This function does NOT catch transport failures. Everything it raises propagates to ``_call``,
    which classifies it via ``classify_transport_error`` — because by the time an exception leaves
    the ``async with`` blocks below, anyio has rewrapped it in an ExceptionGroup, and classifying
    it here (on the un-flattened group) is what lost the denial reason: a refused send was recorded
    as ``{"error": "unhandled errors in a TaskGroup (1 sub-exception)"}`` with the gateway's actual
    "email requires human confirmation" text discarded. Returning an error dict from here was worse
    still — a returned value looks like a SUCCESSFUL write to ``auto_resolve.autonomous_execute``,
    which decides "executed" vs "escalated" purely on whether the invoker raised.
    """
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    endpoint = mcp_endpoint(gateway_url)
    async with streamablehttp_client(endpoint, auth=_sigv4_auth(region)) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool(tool, args)
            if getattr(res, "isError", False):
                # The gateway reports a Policy denial / interceptor rejection this way, and
                # res.content carries the human-readable reason. Raise it verbatim; _call's
                # classifier pulls this message back out of anyio's ExceptionGroup wrapper.
                raise ToolDenied(f"{tool}: {res.content}")
            # Read `content` text parts (not just structuredContent) so the runtime sees the
            # same payload the managed harness does — see parse_tool_result.
            return parse_tool_result(res)
