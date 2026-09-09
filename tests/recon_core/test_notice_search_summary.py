"""Tests for :func:`notice_search_summary` — the full matched-notice set persisted for the UI.

The bug these guard against: the trace's ``tool_output`` is capped at 600 characters, one notice row
is larger than that, and the UI used to re-parse the resulting JSON fragment and report "matched no
notices" on cases that had matched five. This function is the untruncated record that replaces it, so
what matters here is that no row is dropped or altered on the way through — and that a genuinely
empty search still reads as empty rather than as a failure.
"""

import json

from backend.recon_core.proposal_service import (
    MAX_PERSISTED_NOTICE_ROWS,
    notice_search_summary,
)

# Deliberately longer than the 600-char trace cap: a realistic notice row is what broke the old path.
ROW_A = {
    "notice_id": "idp-02-INTEREST-RATESET-V11",
    "notice_class": "rateset_notice",
    "counterparty": "Cindermoor Trust Bank, N.A.",
    "facility": "CINDERMOOR LOGISTICS TL-B $250MM",
    "reference": "WIRE-20260302-EVG",
    "amount": 12500.0,
    "currency": "USD",
    "source_document": "02-INTEREST-RATESET-V11-20260908-155007/Rollover Rate Set Notice.pdf",
    "extraction_confidence": 0.98825,
    "notes": "x" * 400,
}
ROW_B = {"notice_id": "idp-03-PAYDOWN-V11", "amount": 12500.0, "currency": "USD"}


def test_collects_rows_whole_and_untruncated() -> None:
    """Every field of every row survives, which is the entire point of the attribute."""
    out = notice_search_summary(results=[{"rows": [ROW_A]}])

    assert out["searched"] is True
    assert out["rows"] == [ROW_A]
    assert out["omitted"] == 0
    assert out["error"] is None
    # The row is bigger than the trace cap that caused the bug.
    assert len(json.dumps(out["rows"][0])) > 600


def test_accepts_json_string_results_from_the_live_gateway() -> None:
    """The live gateway returns MCP results as text parts, so results arrive as JSON strings."""
    out = notice_search_summary(results=[json.dumps({"rows": [ROW_A, ROW_B]})])

    assert [r["notice_id"] for r in out["rows"]] == [ROW_A["notice_id"], ROW_B["notice_id"]]


def test_deduplicates_by_notice_id_across_calls() -> None:
    """The agent narrows by calling the tool repeatedly; the same notice twice is one notice."""
    out = notice_search_summary(results=[{"rows": [ROW_A, ROW_B]}, {"rows": [ROW_A]}])

    assert [r["notice_id"] for r in out["rows"]] == [ROW_A["notice_id"], ROW_B["notice_id"]]


def test_keeps_rows_that_carry_no_id() -> None:
    """A row with no id cannot be de-duplicated, so it is kept rather than silently dropped."""
    anonymous = {"amount": 1.0}
    out = notice_search_summary(results=[{"rows": [anonymous, anonymous]}])

    assert out["rows"] == [anonymous, anonymous]


def test_merges_matched_on_across_calls_without_duplicates() -> None:
    """Match attributes are reported per call; the panel shows one merged list."""
    out = notice_search_summary(
        results=[
            {"rows": [], "matched_on": ["amount", "fund"]},
            {"rows": [], "matched_on": ["fund", "counterparty"]},
        ]
    )

    assert out["matched_on"] == ["amount", "fund", "counterparty"]


def test_reports_the_first_tool_level_error() -> None:
    """A denied or failed call returns an error instead of rows; the panel names it."""
    out = notice_search_summary(results=[{"error": "ToolDenied: notices"}, {"error": "later"}])

    assert out["error"] == "ToolDenied: notices"
    assert out["rows"] == []
    # It still SEARCHED. An error is not the same as "matched nothing", and the panel says so.
    assert out["searched"] is True


def test_an_empty_result_is_searched_with_no_rows() -> None:
    """A real empty match must stay distinguishable from a display failure."""
    out = notice_search_summary(results=[{"rows": []}])

    assert out == {
        "searched": True,
        "rows": [],
        "matched_on": [],
        "error": None,
        "omitted": 0,
    }


def test_no_search_notices_call_is_not_searched() -> None:
    """An investigation that never called the tool passes an empty list; the panel renders nothing."""
    out = notice_search_summary(results=[])

    assert out["searched"] is False
    assert out["rows"] == []


def test_surplus_rows_are_counted_not_hidden() -> None:
    """The size guard drops whole rows and NAMES how many, so the UI never implies completeness."""
    many = [{"notice_id": f"n-{i}"} for i in range(MAX_PERSISTED_NOTICE_ROWS + 7)]
    out = notice_search_summary(results=[{"rows": many}])

    assert len(out["rows"]) == MAX_PERSISTED_NOTICE_ROWS
    assert out["omitted"] == 7


def test_unparseable_result_contributes_nothing() -> None:
    """A result that is neither a dict nor JSON-decodable to one is skipped, not fatal."""
    out = notice_search_summary(results=["not json", {"rows": [ROW_B]}])

    assert out["rows"] == [ROW_B]
