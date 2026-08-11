"""Assemble the InvokeHarness event stream into a typed agent trace + captured tool I/O.

The harness streams Converse-shape events. This module folds them into:
  * ``steps``        — typed ReasoningStep trace (tool_call / skill_load / propose), the SAME
                       schema the frontend already renders;
  * ``tool_outputs`` — gateway tool results keyed by short tool name (e.g. ``search_ledger``),
                       used by intake to derive the ledger reference the model must NOT pick;
  * ``pending_tool`` — the un-executed toolUse when the stream stops with ``tool_use`` (the
                       worker executes ``submit_proposal`` and re-invokes);
  * ``stop_reason`` / ``usage``.

Event contract this parser expects (mirrors Bedrock Converse streaming + the harness's
server-executed-gateway-tool results). Each event is a one-key dict:
  * ``{"contentBlockStart": {"contentBlockIndex", "start": {"toolUse": {"toolUseId", "name"}}}}``
    — a model tool-USE block; OR ``"start": {"toolResult": {"toolUseId", "status"}}`` — a
    server-executed gateway tool RESULT block (its own block; the payload streams as deltas).
  * ``{"contentBlockDelta": {"contentBlockIndex", "delta": <delta>}}`` where ``<delta>`` is one of
    ``{"text"}`` | ``{"reasoningContent": {"text"}}`` | ``{"toolUse": {"input": "<json chunk>"}}``
    | ``{"toolResult": [{"json"|"text"}]}`` — an ARRAY of tool-result content parts for the
    result block opened at this index (parts carry NO toolUseId/name; that's on the start block).
  * ``{"contentBlockStop": {"contentBlockIndex"}}`` — a result block flushes its accumulated parts.
  * ``{"messageStop": {"stopReason"}}`` / ``{"metadata": {"usage"}}``

The LIVE gateway tool-result shape (confirmed against the AgentCore InvokeHarness API reference:
``HarnessContentBlockStart.toolResult`` + ``HarnessContentBlockDelta.toolResult`` array of
``HarnessToolResultBlockDelta``) is the start+delta-array form above. The parser ALSO tolerates a
top-level or delta-wrapped ``{"toolResult": {toolUseId, name?, content}}`` envelope (the unit-test
fixture shape) so both forms pair correctly.
"""

import json
from dataclasses import dataclass, field

from backend.recon_core.schema import ReasoningStep

# Map gateway-prefixed tool names (target___tool) back to the short name used in the trace + as
# the tool_outputs key. Inverse of harness_config.GATEWAY_TOOLS naming.
_SHORT = {
    "general-ledger___search_ledger": "search_ledger",
    "knowledge-base___search_guidance": "search_guidance",
    "document-extraction___get_results": "get_results",
    "set-draw-status___set_draw_status": "set_draw_status",
    "microsoft-graph___sendSharedMailboxMail": "send_mail",
    # Both mailbox-read forms collapse to one short name so the trace reads the same whichever
    # backend produced it: the harness calls the sanitized `correspondence-search` target, the
    # runtime's in-process wrapper calls the raw Graph op.
    "correspondence-search___search_correspondence": "search_correspondence",
    "microsoft-graph___listSharedMailboxMessages": "search_correspondence",
}


def _short_name(name: str) -> str:
    """Short tool name for a possibly gateway-prefixed name.

    Tolerant matching: names not in the explicit map fall back to the segment after the
    last ``___`` (so ``any-target___any___tool`` still pairs with its result and keys
    ``tool_outputs`` consistently, whichever name form the model used).
    """
    if name in _SHORT:
        return _SHORT[name]
    return name.rsplit("___", 1)[-1] if "___" in (name or "") else name


@dataclass
class StreamResult:
    """Folded result of one InvokeHarness stream."""

    steps: list[ReasoningStep] = field(default_factory=list)
    tool_outputs: dict[str, list] = field(default_factory=dict)
    pending_tool: dict | None = None  # {"toolUseId", "name", "input"} when stop_reason == tool_use
    stop_reason: str = ""
    usage: dict = field(default_factory=dict)
    reasoning_text: str = ""


def _summarize(value) -> str:
    """Compact one-line summary of a tool result for the trace (kept small for the UI)."""
    return json.dumps(value, default=str)[:600]


def _extract_payload(content):
    """Pull the structured payload out of a toolResult, tolerant of the live envelope shape.

    The fixtures use ``content: [{"json": {...}}]``, but the live harness server-executed-tool
    envelope was never fully confirmed (see module docstring). This is deliberately forgiving so
    a differently-keyed live result still yields a real payload instead of ``None`` -> the
    literal string ``"null"`` in the trace:
      * a list of content parts -> first ``json`` part wins, else ALL ``text`` parts concatenated
        (live results chunk one text payload across several parts), else the first non-empty part
        verbatim (unwrapping a lone ``{"content": X}`` nesting);
      * a single part dict -> same rules applied to the one part;
      * a bare scalar/str/dict -> returned as-is.

    :param content: the toolResult ``content`` field (list | dict | scalar | None).
    :returns: the extracted payload, or None only when there is genuinely nothing.
    """
    if content is None:
        return None
    parts = content if isinstance(content, list) else [content]
    text_chunks: list[str] = []
    for part in parts:
        if isinstance(part, dict):
            if "json" in part:
                return part["json"]
            if "text" in part and part["text"] is not None:
                text_chunks.append(str(part["text"]))
    if text_chunks:
        return "".join(text_chunks)
    # No json/text part matched: fall back to the first non-empty part verbatim so an
    # unrecognized envelope shape still surfaces SOMETHING rather than degrading to "null".
    for part in parts:
        if part not in (None, "", {}):
            if isinstance(part, dict) and set(part.keys()) == {"content"}:
                return part["content"]
            return part
    return None


def assemble_stream(events) -> StreamResult:
    """Fold an iterable of harness stream events into a StreamResult.

    :param events: iterable of event dicts (a live stream, or a fake list in tests).
    :returns: the assembled StreamResult.
    """
    res = StreamResult()
    # Open content blocks by index: {"name", "toolUseId", "input_parts": [str]}.
    blocks: dict[int, dict] = {}

    resolved_ids: set = set()  # toolUseIds that already received a toolResult (not pending)
    # tool_call steps indexed by the toolUseId of the originating toolUse block, so a result
    # pairs to its call by ID — robust to a live result event that drops or renames the tool.
    call_step_by_id: dict[str, ReasoningStep] = {}

    def _name_for_tool_use_id(tool_use_id: str | None) -> str | None:
        """Recover the short tool name from the originating toolUse block by id, if any."""
        if not tool_use_id:
            return None
        for b in blocks.values():
            if b.get("toolUseId") == tool_use_id and b.get("name"):
                return _short_name(b["name"])
        return None

    def _record_tool_result(*, tool_use_id: str | None, name: str | None, content: list):
        """Attach a gateway tool result to its toolUse block: trace step + tool_outputs entry."""
        if tool_use_id:
            resolved_ids.add(tool_use_id)
        payload = _extract_payload(content)
        # Resolve the short tool name: explicit on the result, else recovered from the block.
        short = _short_name(name) if name else _name_for_tool_use_id(tool_use_id)

        # Pair the result to a call step. Priority, all robust to name-resolution failure:
        #   1. exact toolUseId match — survives a result that omits/renames the tool;
        #   2. OLDEST still-unfilled tool_call step with the resolved name (FIFO — result N pairs
        #      to call N when a tool is called repeatedly);
        #   3. OLDEST still-unfilled tool_call step of any name (results arrive in call order).
        target = call_step_by_id.get(tool_use_id) if tool_use_id else None
        if target is None and short is not None:
            target = next(
                (s for s in res.steps
                 if s.kind == "tool_call" and s.tool == short and s.tool_output is None), None)
        if target is None:
            target = next(
                (s for s in res.steps
                 if s.kind == "tool_call" and s.tool_output is None), None)

        summary = _summarize(payload) if payload is not None else "(no result payload)"
        if target is not None:
            # Inherit the call step's name so tool_outputs keys consistently for reference
            # derivation even when the result event dropped the name.
            short = short or target.tool or "tool"
            target.tool_output = summary
        else:
            short = short or "tool"
            res.steps.append(
                ReasoningStep(skill=short, confidence=0.0, reasoning=f"{short} result",
                              kind="tool_call", tool=short, tool_output=summary)
            )
        res.tool_outputs.setdefault(short, []).append(payload)


    seq = 0  # monotonic start order — contentBlockIndex RESETS each turn, so it cannot order blocks

    for event in events:
        if "contentBlockStart" in event:
            e = event["contentBlockStart"]
            idx = e.get("contentBlockIndex", len(blocks))
            start = e.get("start") or {}
            tool_use = start.get("toolUse")
            if tool_use:
                seq += 1
                blocks[f"{tool_use.get('toolUseId')}-{idx}"] = {
                    "name": tool_use.get("name"),
                    "toolUseId": tool_use.get("toolUseId"), "input_parts": [], "seq": seq}
                # Deltas/stops reference only the index — remember which block owns it now.
                blocks[idx] = blocks[f"{tool_use.get('toolUseId')}-{idx}"]
            tool_result = start.get("toolResult")
            if tool_result:
                # LIVE shape: a server-executed gateway tool result is its OWN content block.
                # start.toolResult = {toolUseId, status}; the payload arrives as delta.toolResult
                # content parts (see below) and is flushed at contentBlockStop. Register a result
                # block at this index so those deltas accumulate here, paired by toolUseId.
                tuid = tool_result.get("toolUseId")
                if tuid:
                    resolved_ids.add(tuid)
                seq += 1
                blocks[idx] = {"result_for": tuid, "result_parts": [], "seq": seq}
        elif "contentBlockDelta" in event:
            e = event["contentBlockDelta"]
            idx = e.get("contentBlockIndex", -1)
            delta = e.get("delta") or {}
            if "text" in delta:
                res.reasoning_text += delta["text"]
            elif "reasoningContent" in delta:
                res.reasoning_text += delta["reasoningContent"].get("text", "")
            elif "toolUse" in delta:
                blocks.setdefault(idx, {"name": None, "toolUseId": None, "input_parts": []})
                blocks[idx]["input_parts"].append(delta["toolUse"].get("input", ""))
            elif "toolResult" in delta:  # gateway result payload
                tr = delta["toolResult"]
                # LIVE shape: delta.toolResult is an ARRAY of content parts ({"json"}|{"text"})
                # for the result block opened at this index — accumulate; flush at stop. These
                # parts have NO toolUseId/name/content of their own (that's on the start block).
                blk = blocks.get(idx)
                if isinstance(blk, dict) and "result_parts" in blk:
                    parts = tr if isinstance(tr, list) else [tr]
                    for part in parts:
                        if isinstance(part, dict):
                            blk["result_parts"].append(part)
                # FIXTURE/legacy fallback: an envelope-shaped delta ({toolUseId,name,content})
                # is recorded immediately (unit-test shape; keep tolerant).
                elif isinstance(tr, dict) and "content" in tr:
                    _record_tool_result(tool_use_id=tr.get("toolUseId"), name=tr.get("name"),
                                        content=tr.get("content") or [])
                elif isinstance(tr, list):
                    for item_d in tr:
                        if isinstance(item_d, dict) and "content" in item_d:
                            _record_tool_result(tool_use_id=item_d.get("toolUseId"),
                                                name=item_d.get("name"),
                                                content=item_d.get("content") or [])
        elif "toolResult" in event:  # top-level gateway result (can be dict or list)
            tr = event["toolResult"]
            if isinstance(tr, dict):
                _record_tool_result(tool_use_id=tr.get("toolUseId"), name=tr.get("name"),
                                    content=tr.get("content") or [])
            elif isinstance(tr, list):
                # Some harness stream shapes wrap multiple results as a list of dicts.
                for item in tr:
                    if isinstance(item, dict):
                        _record_tool_result(tool_use_id=item.get("toolUseId"), name=item.get("name"),
                                            content=item.get("content") or [])
        elif "contentBlockStop" in event:
            idx = event["contentBlockStop"].get("contentBlockIndex", -1)
            blk = blocks.get(idx)
            if isinstance(blk, dict) and "result_parts" in blk:
                # A server-executed gateway result block closed — flush its accumulated parts
                # to the paired call step (by toolUseId). ONE record per result block, so the
                # trace shows one output per call (no orphan `tool({})` boxes per delta).
                _record_tool_result(tool_use_id=blk.get("result_for"), name=None,
                                    content=blk["result_parts"])
            elif blk and blk.get("name"):
                parsed = _parse_input("".join(blk["input_parts"]))
                short = _short_name(blk["name"])
                if short != "submit_proposal":
                    # A gateway tool call — emit a tool_call trace step (output filled by its result).
                    step = ReasoningStep(
                        skill=short, confidence=0.0,
                        reasoning=f"called {short}", kind="tool_call",
                        tool=short, tool_input=parsed if isinstance(parsed, dict) else None)
                    res.steps.append(step)
                    # Index by toolUseId so its result pairs by id, not by name (see _record_tool_result).
                    if blk.get("toolUseId"):
                        call_step_by_id[blk["toolUseId"]] = step
        elif "messageStop" in event:
            res.stop_reason = event["messageStop"].get("stopReason", "")
        elif "metadata" in event:
            res.usage = event["metadata"].get("usage", {}) or {}

    # If the stream stopped to run a tool, surface the un-executed toolUse (the worker runs
    # submit_proposal). Pick the last open toolUse block whose input parses.
    if res.stop_reason == "tool_use":
        # The pending tool is the MOST RECENTLY STARTED toolUse that never received a
        # toolResult. Order by start sequence, not contentBlockIndex: the index resets every
        # turn, so a resolved earlier tool (e.g. the harness's built-in `skills` loads) can sit
        # at a higher index and shadow the final submit_proposal.
        named = [b for b in blocks.values()
                 if b.get("name") and b.get("toolUseId") not in resolved_ids]
        for blk in sorted(named, key=lambda b: b.get("seq", 0), reverse=True):
            res.pending_tool = {
                "toolUseId": blk.get("toolUseId"),
                "name": _short_name(blk["name"]),
                "raw_name": blk["name"],
                "input": _parse_input("".join(blk["input_parts"])),
            }
            break
    return res


def _parse_input(raw: str):
    """Parse accumulated streamed tool-input JSON; return {} on empty/invalid (fail-soft)."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}
