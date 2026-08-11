"""Gateway MCP transport: short→prefixed tool-name mapping + caller contract (fake session)."""

import asyncio

import pytest

from gateway_mcp import (
    GATEWAY_TOOL_NAMES,
    ToolDenied,
    _run_sync,
    classify_transport_error,
    gateway_tool_name,
    make_gateway_tool_caller,
    mcp_endpoint,
    parse_tool_result,
)


class _Part:
    """Minimal stand-in for an MCP TextContent part (has a .text attribute)."""

    def __init__(self, text):
        self.text = text


class _Res:
    """Minimal stand-in for an MCP CallToolResult."""

    def __init__(self, *, content=None, structured=None):
        self.content = content
        self.structuredContent = structured


def test_mcp_endpoint_appends_mcp_suffix():
    base = "https://recon-dev-gateway-abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com"
    # GetGateway returns the bare host — the MCP transport needs the /mcp path appended.
    assert mcp_endpoint(base) == f"{base}/mcp"
    # Trailing slash is normalized, and an already-suffixed URL is left unchanged (idempotent).
    assert mcp_endpoint(f"{base}/") == f"{base}/mcp"
    assert mcp_endpoint(f"{base}/mcp") == f"{base}/mcp"


def test_tool_name_mapping_covers_all_agent_tools():
    assert gateway_tool_name("search_ledger") == "general-ledger___search_ledger"
    assert gateway_tool_name("search_guidance") == "knowledge-base___search_guidance"
    assert gateway_tool_name("get_results") == "document-extraction___IDPTools___get_results"
    assert gateway_tool_name("set_draw_status") == "set-draw-status___set_draw_status"
    # Mailbox read routes through the existing microsoft-graph OpenAPI target; there is no
    # send_notification short name any more (email send is the microsoft-graph OpenAPI op).
    assert (
        gateway_tool_name("search_correspondence")
        == "microsoft-graph___listSharedMailboxMessages"
    )
    # There is no send mapping: nothing the agent reaches through this transport sends mail, so
    # "send_mail" is just an unknown name that passes through (and would fail at the gateway).
    assert gateway_tool_name("send_mail") == "send_mail"
    assert not any(
        "sendSharedMailboxMail" in name for name in GATEWAY_TOOL_NAMES.values()
    )
    assert gateway_tool_name("send_notification") == "send_notification"  # no mapping → passthrough
    # Unknown names pass through unchanged.
    assert gateway_tool_name("mystery") == "mystery"


def test_caller_invokes_session_with_mapped_name():
    seen = []

    def fake_session(tool, args):
        seen.append((tool, args))
        return {"rows": [{"reference": "DDTL-A-0001"}]}

    caller = make_gateway_tool_caller(
        gateway_url="https://gw/mcp", region="us-east-1", session_factory=fake_session
    )
    out = caller("search_ledger", {"reference": "DDTL-A-0001"})
    assert seen == [("general-ledger___search_ledger", {"reference": "DDTL-A-0001"})]
    assert out["rows"][0]["reference"] == "DDTL-A-0001"


def test_run_sync_drives_coroutine_without_running_loop():
    """No event loop running (plain sync context) — _run_sync drives the coroutine directly."""

    async def _coro():
        return 42

    assert _run_sync(_coro()) == 42


def test_run_sync_works_inside_running_event_loop():
    """Regression: the async @app.entrypoint handler runs inside a live loop, so the tool
    caller's asyncio.run() raised 'cannot be called from a running event loop' and left the
    MCP coroutine un-awaited. _run_sync must complete the coroutine from within a running loop.
    """

    async def _inner():
        return "ok"

    async def _driver():
        # Simulates the async handler calling the SYNCHRONOUS tool caller mid-await.
        return _run_sync(_inner())

    assert asyncio.run(_driver()) == "ok"


def test_parse_tool_result_reads_text_content_json():
    """THE bug fix: the live gateway returns the payload as a `content` TEXT part (no output
    schema → empty structuredContent). The runtime must parse it, not return {}."""
    res = _Res(content=[_Part('{"rows": [{"entry_id": "GL-2026-000103"}], "count": 1}')])
    out = parse_tool_result(res)
    assert out["count"] == 1
    assert out["rows"][0]["entry_id"] == "GL-2026-000103"


def test_parse_tool_result_prefers_structured_content_when_present():
    res = _Res(content=[_Part('{"rows": []}')], structured={"rows": [{"x": 1}]})
    assert parse_tool_result(res) == {"rows": [{"x": 1}]}


def test_parse_tool_result_concatenates_chunked_text_parts():
    """Live results chunk one JSON payload across several text parts."""
    res = _Res(content=[_Part('{"rows": ['), _Part('{"a": 1}'), _Part("]}")])
    assert parse_tool_result(res) == {"rows": [{"a": 1}]}


def test_parse_tool_result_empty_content_is_empty_dict():
    assert parse_tool_result(_Res(content=[])) == {}
    assert parse_tool_result(_Res(content=None)) == {}


def test_parse_tool_result_genuinely_empty_result_survives():
    """A real 'no rows' result must round-trip as {rows:[],count:0}, not be mistaken for empty."""
    res = _Res(content=[_Part('{"rows": [], "count": 0}')])
    assert parse_tool_result(res) == {"rows": [], "count": 0}


def test_parse_tool_result_non_json_text_is_surfaced():
    res = _Res(content=[_Part("plain text, not json")])
    assert parse_tool_result(res) == {"result": "plain text, not json"}


def test_caller_propagates_tool_denied():
    def deny(tool, args):
        raise ToolDenied("policy: confidence below threshold")

    caller = make_gateway_tool_caller(
        gateway_url="https://gw/mcp", region="us-east-1", session_factory=deny
    )
    with pytest.raises(ToolDenied):
        caller("set_draw_status", {"reference": "R", "status": "Cancelled", "confidence": 0.5})


# --- anyio ExceptionGroup unwrapping -------------------------------------------------------
# MCP tool calls run inside an anyio task group, and anyio 4 (strict_exception_groups=True by
# default) rewraps even a SINGLE exception into an ExceptionGroup whose str() is only "unhandled
# errors in a TaskGroup (1 sub-exception)". Live QA (2026-08-09) caught a real send denial being
# recorded with exactly that text and the gateway's "email requires human confirmation" reason
# discarded — so these tests pin the classifier to the flattened LEAVES, never str(group).


def test_classify_unwraps_group_wrapped_tool_denied():
    """A ToolDenied leaf inside an ExceptionGroup stays a ToolDenied and keeps its reason."""
    leaf = ToolDenied(
        "microsoft-graph___sendSharedMailboxMail: denied - email requires human confirmation"
    )
    group = ExceptionGroup("unhandled errors in a TaskGroup", [leaf])

    out = classify_transport_error(group)

    assert isinstance(out, ToolDenied)
    assert "human confirmation" in str(out)
    # The group's own useless string must not survive into the message.
    assert "TaskGroup" not in str(out)


def test_classify_detects_denial_by_message_when_leaf_is_generic():
    """A 403/AccessDenied leaf of any exception type is still classified as a denial."""
    group = ExceptionGroup(
        "unhandled errors in a TaskGroup",
        [RuntimeError("AccessDeniedException: not authorized to perform bedrock-agentcore:*")],
    )
    assert isinstance(classify_transport_error(group), ToolDenied)


def test_classify_non_denial_becomes_runtime_error_with_leaf_text():
    """A genuine transport fault is a RuntimeError, but still names the real cause."""
    group = ExceptionGroup(
        "unhandled errors in a TaskGroup", [ConnectionError("connect timeout to gateway")]
    )
    out = classify_transport_error(group)
    assert isinstance(out, RuntimeError) and not isinstance(out, ToolDenied)
    assert "connect timeout to gateway" in str(out)


def test_classify_flattens_nested_groups():
    """Nesting is what real anyio produces (task group inside task group)."""
    inner = ExceptionGroup("inner", [ToolDenied("policy denied the write")])
    outer = ExceptionGroup("unhandled errors in a TaskGroup", [inner])
    out = classify_transport_error(outer)
    assert isinstance(out, ToolDenied)
    assert "policy denied the write" in str(out)


def test_classify_handles_a_bare_unwrapped_exception():
    """Not everything arrives wrapped — a direct exception must classify the same way."""
    assert isinstance(classify_transport_error(ToolDenied("denied")), ToolDenied)
    assert isinstance(classify_transport_error(ValueError("bad args")), RuntimeError)
