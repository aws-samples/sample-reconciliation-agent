"""Argument sanitization for the correspondence-search gateway target.

The whole point of this target is that the model never touches an OData argument, so these
tests pin the two forms whose violation fails as an opaque MCP "unhandled errors in a
TaskGroup" — a double-quoted ``$search`` literal and an integer ``$top`` — plus the fact that
the mailbox is deployment config, never a tool argument.
"""

import pytest

from backend.correspondence_tool.handler import (
    DEFAULT_TOP,
    GRAPH_READ_TOOL,
    MAX_TOP,
    handle,
)

MAILBOX = "shared@example.onmicrosoft.com"


class _Recorder:
    """Transport seam capturing the upstream call instead of hitting the gateway."""

    def __init__(self, result: dict | None = None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._result = result if result is not None else {"content": [{"text": "[]"}]}

    def __call__(self, tool_name: str, arguments: dict) -> dict:
        self.calls.append((tool_name, arguments))
        return self._result


@pytest.fixture(autouse=True)
def _mailbox(monkeypatch):
    monkeypatch.setenv("GRAPH_MAILBOX", MAILBOX)


def test_wraps_the_search_text_in_a_double_quoted_odata_literal():
    """A bare hyphenated reference is an OData syntax error, so the quotes are load-bearing."""
    rec = _Recorder()
    handle({"query": "DRW-2026-00417"}, transport=rec)
    tool, args = rec.calls[0]
    assert tool == GRAPH_READ_TOOL
    assert args["$search"] == '"DRW-2026-00417"'


def test_sends_top_as_an_integer_not_a_string():
    """The gateway's schema check rejects "10"; a model may well emit the string form."""
    rec = _Recorder()
    handle({"query": "cancellation", "top": "5"}, transport=rec)
    assert rec.calls[0][1]["$top"] == 5
    assert isinstance(rec.calls[0][1]["$top"], int)


def test_top_defaults_and_is_capped():
    rec = _Recorder()
    handle({"query": "x"}, transport=rec)
    assert rec.calls[0][1]["$top"] == DEFAULT_TOP

    rec = _Recorder()
    handle({"query": "x", "top": 5000}, transport=rec)
    assert rec.calls[0][1]["$top"] == MAX_TOP


def test_the_mailbox_comes_from_the_environment_and_cannot_be_overridden_by_the_caller():
    """The model must not be able to redirect the read at another tenant mailbox."""
    rec = _Recorder()
    handle({"query": "x", "mailboxAddress": "ceo@example.com"}, transport=rec)
    assert rec.calls[0][1]["mailboxAddress"] == MAILBOX


def test_inner_quotes_are_stripped_rather_than_escaped():
    """Graph's $search literal accepts no escaped quote, so an inner quote must not survive."""
    rec = _Recorder()
    handle({"query": 'say "hello"'}, transport=rec)
    assert rec.calls[0][1]["$search"] == '"say hello"'


def test_an_empty_query_fails_loudly_instead_of_searching_everything():
    rec = _Recorder()
    with pytest.raises(ValueError, match="query is required"):
        handle({"query": "   "}, transport=rec)
    with pytest.raises(ValueError, match="query is required"):
        handle({}, transport=rec)
    assert rec.calls == []  # nothing reached the gateway


def test_a_non_numeric_top_fails_loudly():
    rec = _Recorder()
    with pytest.raises(ValueError, match="whole number"):
        handle({"query": "x", "top": "many"}, transport=rec)
    with pytest.raises(ValueError, match="at least 1"):
        handle({"query": "x", "top": 0}, transport=rec)
    assert rec.calls == []


def test_an_unset_mailbox_is_an_error_not_a_blank_graph_call(monkeypatch):
    monkeypatch.setenv("GRAPH_MAILBOX", "")
    with pytest.raises(ValueError, match="GRAPH_MAILBOX is not configured"):
        handle({"query": "x"}, transport=_Recorder())


def test_the_upstream_result_is_returned_unchanged():
    """Translation is argument-only: the harness must see what the runtime sees."""
    payload = {"content": [{"text": '{"value": [{"subject": "Re: DRW-2026-00417"}]}'}]}
    got = handle({"query": "DRW-2026-00417"}, transport=_Recorder(result=payload))
    assert got is payload


def test_the_target_never_calls_itself():
    """Guards the one loop risk of routing back through the gateway."""
    rec = _Recorder()
    handle({"query": "x"}, transport=rec)
    assert "correspondence" not in rec.calls[0][0]
