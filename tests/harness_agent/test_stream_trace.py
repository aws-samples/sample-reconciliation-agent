"""Harness stream → typed-trace assembly: tool calls, gateway results, pending submit_proposal."""

from backend.harness_agent.stream import assemble_stream


def _search_ledger_call_events(idx, tool_use_id, args_json):
    """Events for one gateway search_ledger tool call + its harness-executed result."""
    return [
        {"contentBlockStart": {"contentBlockIndex": idx,
                               "start": {"toolUse": {"toolUseId": tool_use_id,
                                                     "name": "general-ledger___search_ledger"}}}},
        {"contentBlockDelta": {"contentBlockIndex": idx, "delta": {"toolUse": {"input": args_json}}}},
        {"contentBlockStop": {"contentBlockIndex": idx}},
        {"toolResult": {"toolUseId": tool_use_id, "name": "general-ledger___search_ledger",
                        "content": [{"json": {"rows": [{"reference": "DDTL-A-0001", "amount": "14000000"}]}}],
                        "status": "success"}},
    ]


def test_assembles_tool_call_step_and_captures_output():
    events = [
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": "Let me check the ledger."}}}},
        *_search_ledger_call_events(1, "tu-1", '{"reference": "DDTL-A-0001"}'),
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 50}}},
    ]
    res = assemble_stream(events)

    assert res.stop_reason == "end_turn"
    assert res.usage["outputTokens"] == 50
    assert "check the ledger" in res.reasoning_text
    # A tool_call step for search_ledger, with input captured and output summarized.
    calls = [s for s in res.steps if s.kind == "tool_call" and s.tool == "search_ledger"]
    assert len(calls) == 1
    assert calls[0].tool_input == {"reference": "DDTL-A-0001"}
    assert "DDTL-A-0001" in calls[0].tool_output
    # Gateway result recorded under the short tool name for reference derivation.
    assert res.tool_outputs["search_ledger"][0]["rows"][0]["reference"] == "DDTL-A-0001"


def test_captures_pending_submit_proposal_on_tool_use_stop():
    events = [
        *_search_ledger_call_events(0, "tu-1", '{"reference": "DDTL-A-0001"}'),
        {"contentBlockStart": {"contentBlockIndex": 1,
                               "start": {"toolUse": {"toolUseId": "tu-2", "name": "submit_proposal"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"class_name": "document-cross-reference",'}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": ' "resolution": "Mark cancelled", "classification_reasoning": "x", "status": "Cancelled"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]
    res = assemble_stream(events)

    assert res.stop_reason == "tool_use"
    assert res.pending_tool is not None
    assert res.pending_tool["name"] == "submit_proposal"
    assert res.pending_tool["toolUseId"] == "tu-2"
    # Streamed JSON input reassembled + parsed.
    assert res.pending_tool["input"]["class_name"] == "document-cross-reference"
    assert res.pending_tool["input"]["status"] == "Cancelled"


def test_result_without_name_pairs_to_call_by_tool_use_id():
    """Live results that drop the tool name must still pair by toolUseId, not degrade to 'tool'.

    Reproduces the reported trace bug: a result event carrying only toolUseId (no name) was
    collapsing onto a standalone ``tool({}) -> null`` step instead of filling its call step.
    """
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "tu-9",
                                                     "name": "general-ledger___search_ledger"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"reference": "DDTL-A-0001"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        # Result envelope with NO name — only the id ties it back to the call.
        {"toolResult": {"toolUseId": "tu-9",
                        "content": [{"json": {"rows": [{"reference": "DDTL-A-0001"}]}}],
                        "status": "success"}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    res = assemble_stream(events)

    calls = [s for s in res.steps if s.kind == "tool_call"]
    assert len(calls) == 1  # no bogus standalone "tool" step
    assert calls[0].tool == "search_ledger"
    assert "DDTL-A-0001" in calls[0].tool_output
    # Recovered the short name from the originating block -> keyed for reference derivation.
    assert res.tool_outputs["search_ledger"][0]["rows"][0]["reference"] == "DDTL-A-0001"


def test_payload_extraction_tolerates_alternate_envelope():
    """A result whose content is a bare dict (not [{'json': ...}]) must not summarize to 'null'."""
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "tu-3",
                                                     "name": "managed-kb___Retrieve"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"query": "loan confirmation"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"toolResult": {"toolUseId": "tu-3", "content": {"guidance": "match on reference"}, "status": "success"}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    res = assemble_stream(events)

    call = next(s for s in res.steps if s.kind == "tool_call" and s.tool == "search_guidance")
    assert "match on reference" in call.tool_output
    assert call.tool_output != "null"
    assert res.tool_outputs["search_guidance"][0]["guidance"] == "match on reference"


def test_repeated_same_tool_results_pair_in_call_order():
    """Two search_ledger calls + two id-less results pair FIFO (result N -> call N)."""
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "tu-a", "name": "general-ledger___search_ledger"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"reference": "A"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"contentBlockStart": {"contentBlockIndex": 1,
                               "start": {"toolUse": {"toolUseId": "tu-b", "name": "general-ledger___search_ledger"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"reference": "B"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"toolResult": {"toolUseId": "tu-a", "content": [{"json": {"rows": [{"reference": "A"}]}}], "status": "success"}},
        {"toolResult": {"toolUseId": "tu-b", "content": [{"json": {"rows": [{"reference": "B"}]}}], "status": "success"}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    res = assemble_stream(events)

    calls = [s for s in res.steps if s.kind == "tool_call"]
    assert len(calls) == 2
    assert "A" in calls[0].tool_output and "B" in calls[1].tool_output


def test_no_pending_tool_when_stream_ends_normally():
    res = assemble_stream([{"messageStop": {"stopReason": "end_turn"}}])
    assert res.pending_tool is None
    assert res.stop_reason == "end_turn"


def test_live_result_block_shape_pairs_and_captures_output():
    """LIVE shape: a gateway result is its OWN content block (start.toolResult + delta array).

    Regression for the empty-tool-output bug: the live harness delivers the result as a
    separate content block whose start carries only {toolUseId, status} and whose deltas carry
    an ARRAY of {json}/{text} content parts (no toolUseId/name/content). The parser must
    accumulate those parts, flush ONE record at stop, and pair it to the call by toolUseId —
    never emit an orphan ``tool({})`` step per delta nor summarize to "(no result payload)".
    """
    events = [
        # The model's tool-use block (call).
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "tu-live",
                                                     "name": "general-ledger___search_ledger"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"reference": "DDTL-A-0001"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        # The server-executed result as its OWN block (contentBlockIndex reuses 0 next turn).
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolResult": {"toolUseId": "tu-live", "status": "success"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0,
                               "delta": {"toolResult": [{"json": {"rows": [{"reference": "DDTL-A-0001"}]}}]}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    res = assemble_stream(events)

    calls = [s for s in res.steps if s.kind == "tool_call"]
    # Exactly one call step, paired to its result — no orphan tool({}) boxes.
    assert len(calls) == 1
    assert calls[0].tool == "search_ledger"
    assert calls[0].tool_input == {"reference": "DDTL-A-0001"}
    assert "DDTL-A-0001" in calls[0].tool_output
    assert calls[0].tool_output != "(no result payload)"
    # Result recorded under the short name for reference derivation.
    assert res.tool_outputs["search_ledger"][0]["rows"][0]["reference"] == "DDTL-A-0001"


def test_live_result_block_chunked_text_parts_accumulate():
    """Chunked delta parts for one result block accumulate into a single output record."""
    events = [
        {"contentBlockStart": {"contentBlockIndex": 2,
                               "start": {"toolUse": {"toolUseId": "tu-kb",
                                                     "name": "managed-kb___Retrieve"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 2, "delta": {"toolUse": {"input": '{"query": "x"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 2}},
        {"contentBlockStart": {"contentBlockIndex": 2,
                               "start": {"toolResult": {"toolUseId": "tu-kb", "status": "success"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 2, "delta": {"toolResult": [{"text": "match on "}]}}},
        {"contentBlockDelta": {"contentBlockIndex": 2, "delta": {"toolResult": [{"text": "reference"}]}}},
        {"contentBlockStop": {"contentBlockIndex": 2}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    res = assemble_stream(events)

    calls = [s for s in res.steps if s.kind == "tool_call"]
    assert len(calls) == 1
    # Both text chunks captured; no orphan steps.
    assert "match on " in calls[0].tool_output and "reference" in calls[0].tool_output
    assert len([s for s in res.steps if s.kind == "tool_call"]) == 1
