"""Tests for llm.py: extract_json, strands_json (temperature-deprecation + token-cap retries),
and classify_with_consistency (self-consistency majority vote).

The Strands call is replaced by the ``caller`` seam — ``callable(*, model_id, system, prompt,
max_tokens, temperature) -> (text, stop_reason)`` — so the prompt assembly, the retries and the
vote are exercised without a live Bedrock model.
"""

import json

import pytest

from backend.recon_core.schema import ReconItem
from llm import _result_text, classify_with_consistency, extract_json, strands_json


class _FakeCaller:
    """Canned-reply stand-in for the Strands single-turn call; records what each attempt sent.

    ``reject_temperature`` mimics Claude Sonnet 5, which raises a ValidationException when the
    request carries the deprecated ``temperature`` inference parameter. Replies may be dicts
    (JSON-encoded into the reply text with stop_reason ``end_turn``) or ``(text, stop_reason)``
    tuples for raw/truncated replies.
    """

    def __init__(self, replies: list, reject_temperature: bool = False):
        self._replies = list(replies)
        self.prompts: list[str] = []
        self.caps: list[int] = []
        self.temps: list[float | None] = []
        self._reject_temperature = reject_temperature

    def __call__(self, *, model_id, system, prompt, max_tokens, temperature):
        """Record the attempt and return the next canned ``(text, stop_reason)``."""
        self.caps.append(max_tokens)
        self.temps.append(temperature)
        if self._reject_temperature and temperature is not None:
            raise Exception(
                "An error occurred (ValidationException): `temperature` is deprecated here."
            )
        self.prompts.append(prompt)
        nxt = self._replies.pop(0)
        if isinstance(nxt, tuple):
            return nxt
        return json.dumps(nxt), "end_turn"


ITEM = ReconItem(
    item_id="idp-n1.pdf",
    domain="cash",
    sides=[],
    attributes={"idp_class": "LoanRateSettingNotice", "idp_attributes": {"Date": "26-Dec-2026"}},
)

CATALOG = [
    {"name": "timing", "description": "timing breaks"},
    {"name": "unknown", "description": "fallback"},
]


def test_extract_json_plain_and_fenced():
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json('Sure! Here is the answer:\n```json\n{"a": {"b": 2}}\n```\nDone.') == {
        "a": {"b": 2}
    }


def test_extract_json_no_object_raises():
    with pytest.raises(ValueError):
        extract_json("I could not classify this item.")


def test_extract_json_ignores_braces_inside_strings():
    # The live failure mode: `reasoning` quotes a dict-shaped snippet, so a naive brace counter
    # closes the object early, fails to parse every candidate, and reports "no JSON object".
    reply = (
        '{"name": "record-match-review", "confidence": 0.72, "reasoning": "the ledger row is'
        ' {\\"reference\\": \\"DRAW-1\\"} and the bank side shows } stray braces {"}'
    )
    out = extract_json(reply)
    assert out["name"] == "record-match-review"
    assert out["confidence"] == 0.72
    assert "stray braces" in out["reasoning"]


def test_extract_json_handles_escaped_backslash_before_quote():
    # A trailing escaped backslash must NOT swallow the closing quote of the string.
    assert extract_json(r'{"a": "back\\", "b": 1}') == {"a": "back\\", "b": 1}


def test_extract_json_truncated_reply_says_so_and_shows_the_tail():
    # A reply cut off at the token cap: the error must name the cause and expose the tail, so a
    # truncation is distinguishable from a malformed reply in the logs.
    reply = '{"name": "record-match-review", "confidence": 0.72, "reasoning": "' + "x" * 500
    with pytest.raises(ValueError) as err:
        extract_json(reply)
    msg = str(err.value)
    assert "cut off mid-object" in msg
    assert f"{len(reply)} chars" in msg
    assert "tail=" in msg


def test_extract_json_skips_a_prose_brace_and_finds_the_real_object():
    # An unparseable first candidate must not stop the scan.
    assert extract_json('note {not json} then {"a": 1}') == {"a": 1}


def test_result_text_reads_the_final_assistant_message():
    """Strands returns an AgentResult; the classifier and the investigator both read its final
    message text (not the forced-tool structured_output), so one helper serves both."""

    class _Result:
        message = {"role": "assistant", "content": [{"text": '{"a": '}, {"text": "1}"}]}

    assert _result_text(_Result()) == '{"a": 1}'
    assert _result_text("already text") == "already text"  # plain-string agents (test fakes)


def test_strands_json_retries_once_when_the_reply_hits_the_token_cap():
    # stop_reason=max_tokens → the JSON is necessarily incomplete; retry with a bigger cap.
    truncated = '{"name": "timing", "confidence": 0.9, "reasoning": "cut off here'
    fc = _FakeCaller(
        [
            (truncated, "max_tokens"),
            ('{"name": "timing", "confidence": 0.9, "reasoning": "short"}', "end_turn"),
        ]
    )
    out = strands_json(model_id="m", system="s", prompt="p", max_tokens=1500, caller=fc)
    assert out["name"] == "timing"
    assert fc.caps == [1500, 3000]
    # The retry carries an explicit brevity instruction so the second reply actually fits.
    assert "under 500 characters" in fc.prompts[1]


def test_strands_json_fails_loudly_when_the_retry_is_also_truncated():
    # Bounded retry: a persistently truncated reply must raise, never a fabricated result.
    truncated = ('{"name": "timing", "reasoning": "cut', "max_tokens")
    fc = _FakeCaller([truncated, truncated])
    with pytest.raises(ValueError, match="cut off mid-object"):
        strands_json(model_id="m", system="s", prompt="p", max_tokens=100, caller=fc)
    assert len(fc.caps) == 2  # exactly one retry, not a loop


def test_strands_json_drops_temperature_when_model_rejects_it():
    # Sonnet 5 deprecated `temperature`; strands_json must retry WITHOUT it rather than 500.
    fc = _FakeCaller([{"ok": 1}], reject_temperature=True)
    out = strands_json(
        model_id="us.anthropic.claude-sonnet-5-reject-temp",
        system="s",
        prompt="p",
        temperature=0.7,
        caller=fc,
    )
    assert out == {"ok": 1}
    # First attempt sent temperature (rejected); the retry omitted it.
    assert fc.temps == [0.7, None]


def test_classify_with_consistency_majority_vote_and_prompt():
    # 3 samples: timing, timing, unknown → majority 'timing', consistency 2/3.
    fc = _FakeCaller(
        [
            {"name": "timing", "confidence": 0.9, "reasoning": "value date off"},
            {"name": "timing", "confidence": 0.8, "reasoning": "again"},
            {"name": "unknown", "confidence": 0.5, "reasoning": "unsure"},
        ]
    )
    name, conf, reasoning, consistency = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, caller=fc
    )
    assert name == "timing"
    assert consistency == pytest.approx(2 / 3)
    # The prompt carries the catalog AND the item's IDP-extracted data.
    assert "timing breaks" in fc.prompts[0]
    assert "26-Dec-2026" in fc.prompts[0]
    # Each sample is a separate call — three independent draws, not one reused conversation.
    assert len(fc.prompts) == 3


def test_default_caller_pins_streaming_off(monkeypatch):
    """The runtime must never issue a `ConverseStream` call: Strands' `BedrockModel` defaults to
    streaming, so ``streaming=False`` is asserted on the constructor kwargs. A future default flip
    (or a dropped kwarg) fails here rather than silently changing the wire API in production."""
    import llm
    import strands
    import strands.models

    seen: dict = {}

    class _SpyModel:
        def __init__(self, **kw):
            seen.update(kw)

    class _SpyAgent:
        def __init__(self, **kw):
            seen["agent_kwargs"] = kw

        def __call__(self, prompt):
            return '{"ok": 1}'

    monkeypatch.setattr(strands.models, "BedrockModel", _SpyModel)
    monkeypatch.setattr(strands, "Agent", _SpyAgent)

    out = llm.strands_json(model_id="m", system="s", prompt="p", max_tokens=42, temperature=0.7)
    assert out == {"ok": 1}
    assert seen["streaming"] is False
    assert seen["model_id"] == "m" and seen["max_tokens"] == 42 and seen["temperature"] == 0.7
    # Classification is single-turn: no tools, and the sampled replies stay out of stdout.
    assert seen["agent_kwargs"]["tools"] == []
    assert seen["agent_kwargs"]["callback_handler"] is None
