"""Tests for llm.py: extract_json, strands_json (temperature-deprecation + token-cap retries),
and classify_with_consistency (self-consistency majority vote).

The Strands call is replaced by the ``caller`` seam — ``callable(*, model_id, system, prompt,
max_tokens, temperature) -> (text, stop_reason, usage)`` — so the prompt assembly, the retries and the
vote are exercised without a live Bedrock model.

Token usage flowing through that seam has its own file (``test_runtime_token_usage.py``); the fake
here returns an empty usage dict, which is what a reply carrying no metrics reports.
"""

import json

import pytest

import llm
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
        """Record the attempt and return the next canned ``(text, stop_reason, usage)``."""
        self.caps.append(max_tokens)
        self.temps.append(temperature)
        if self._reject_temperature and temperature is not None:
            raise Exception(
                "An error occurred (ValidationException): `temperature` is deprecated here."
            )
        self.prompts.append(prompt)
        nxt = self._replies.pop(0)
        # A two-element canned reply is a raw/truncated (text, stop_reason) pair; this file asserts
        # nothing about cost, so it reports no usage counts at all rather than inventing zeros.
        if isinstance(nxt, tuple):
            return (*nxt, {})
        return json.dumps(nxt), "end_turn", {}


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


@pytest.fixture(autouse=True)
def _forget_learned_temperature_rejections():
    """`_NO_TEMPERATURE` is module state; a learned entry would leak between tests."""
    llm._NO_TEMPERATURE.clear()
    yield
    llm._NO_TEMPERATURE.clear()


@pytest.mark.parametrize(
    "model_id",
    [
        "us.anthropic.claude-sonnet-5",
        "global.anthropic.claude-sonnet-5",
        "us.anthropic.claude-opus-5",
        "us.anthropic.claude-fable-5-1",
        "us.anthropic.claude-opus-4-8",
        "US.ANTHROPIC.CLAUDE-SONNET-5",  # id casing must not decide this
    ],
)
def test_temperature_is_never_sent_to_a_model_that_removed_it(model_id):
    """The point of the change: ONE call, not a doomed probe plus a retry.

    Every id this platform can be configured with is in this generation, so learning the fact per
    container meant a guaranteed ValidationException on every cold start — and the retry it forced is
    what a real case died on when that retry hit a transient ServiceUnavailableException.
    """
    fc = _FakeCaller([{"ok": 1}], reject_temperature=True)

    out = strands_json(model_id=model_id, system="s", prompt="p", temperature=0.7, caller=fc)

    assert out == {"ok": 1}
    assert fc.temps == [None], "sent temperature to a model known to reject it"
    assert len(fc.caps) == 1, "made a wasted probe call"


def test_temperature_is_sent_to_a_model_that_accepts_it():
    """Omission is the default, not the only behaviour — sampling diversity still works elsewhere."""
    fc = _FakeCaller([{"ok": 1}])

    strands_json(
        model_id="amazon.nova-pro-v1:0", system="s", prompt="p", temperature=0.7, caller=fc
    )

    assert fc.temps == [0.7]


def test_an_unknown_model_that_rejects_temperature_is_still_learned():
    """The runtime fallback is retained for an id the markers do not cover (a future model)."""
    fc = _FakeCaller([{"ok": 1}], reject_temperature=True)

    out = strands_json(
        model_id="vendor.some-future-model-v9", system="s", prompt="p", temperature=0.7, caller=fc
    )

    assert out == {"ok": 1}
    # Probed once, rejected, retried without it — and remembered.
    assert fc.temps == [0.7, None]
    assert "vendor.some-future-model-v9" in llm._NO_TEMPERATURE


def test_a_learned_rejection_suppresses_temperature_on_the_next_call():
    """Learning must actually save the second container-local call, not just record a fact."""
    llm._NO_TEMPERATURE.add("vendor.some-future-model-v9")
    fc = _FakeCaller([{"ok": 1}], reject_temperature=True)

    strands_json(
        model_id="vendor.some-future-model-v9", system="s", prompt="p", temperature=0.7, caller=fc
    )

    assert fc.temps == [None]


def test_accepts_temperature_is_decided_without_a_call():
    assert llm._accepts_temperature("us.anthropic.claude-sonnet-5") is False
    assert llm._accepts_temperature("us.anthropic.claude-sonnet-4-5") is True
    assert llm._accepts_temperature("amazon.nova-pro-v1:0") is True


def test_classify_with_consistency_majority_vote_and_prompt():
    # 3 samples: timing, timing, unknown → majority 'timing'. The minority sample supplies the
    # reasoning ONLY if the majority filter is broken, which is what makes it worth asserting.
    fc = _FakeCaller(
        [
            {"name": "timing", "reasoning": "value date off"},
            {"name": "timing", "reasoning": "again"},
            {"name": "unknown", "reasoning": "unsure"},
        ]
    )
    vote = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, caller=fc
    )
    assert vote.name == "timing"
    assert vote.reasoning in ("value date off", "again")
    # The prompt carries the catalog AND the item's IDP-extracted data.
    assert "timing breaks" in fc.prompts[0]
    assert "26-Dec-2026" in fc.prompts[0]
    # Each sample is a separate call — three independent draws, not one reused conversation.
    assert len(fc.prompts) == 3


def test_the_classifier_prompt_asks_for_no_confidence():
    """The k-sample vote yields a class and its reasoning, and no number.

    Neither candidate number would be read: an agreement fraction is discarded at the call site, and a
    self-reported mean feeding a floor only ever produces mass false negatives. A prompt that asks for
    a number nobody reads invites a future reader to start reading it — and the parse would
    ``KeyError`` the moment a model omitted a key nothing depends on.
    """
    fc = _FakeCaller([{"name": "timing", "reasoning": "r"}] * 3)
    classify_with_consistency(model_id="m", system="s", item=ITEM, catalog=CATALOG, caller=fc)
    assert "confidence" not in fc.prompts[0]


def test_classification_prompt_withholds_the_tier1_hint():
    """The k samples are only independent draws if the classifier is not handed the answer.

    Tier-1 stamps ``tier1_break_type`` onto the item's attributes, and the classification prompt
    serializes the whole item — so without the filter the hint reaches the classifier through the
    item even though the explicit hint block is confined to the investigation prompt. This asserts
    the leak is closed while the rest of the item's data still gets through.
    """
    hinted = ReconItem(
        item_id="idp-n2.pdf",
        domain="cash",
        sides=[],
        attributes={
            "idp_attributes": {"Date": "26-Dec-2026"},
            "tier1_break_type": "record-match-review",
            "tier1_escalation_reason": "tolerance_miss",
        },
    )
    fc = _FakeCaller([{"name": "timing", "reasoning": "r"}] * 3)
    classify_with_consistency(model_id="m", system="s", item=hinted, catalog=CATALOG, caller=fc)
    prompt = fc.prompts[0]
    assert "tier1_break_type" not in prompt
    assert "record-match-review" not in prompt
    # Only the two hint keys are withheld — the escalation reason included, since it names the rule
    # that produced the hint. Everything else the classifier needs is still there.
    assert "tier1_escalation_reason" not in prompt and "tolerance_miss" not in prompt
    assert "26-Dec-2026" in prompt


def test_investigation_prompt_keeps_the_tier1_hint():
    """The filter is scoped to classification: the investigation prompt shows the hint on purpose."""
    from strands_investigator import _prompt

    hinted = ReconItem(
        item_id="idp-n3.pdf",
        domain="cash",
        sides=[],
        attributes={"tier1_break_type": "record-match-review"},
    )
    text = _prompt(hinted, [{"name": "record-match-review", "body": "procedure"}], None)
    assert "record-match-review" in text
    # And filtering for the classification prompt must not have mutated the item itself.
    assert hinted.attributes["tier1_break_type"] == "record-match-review"


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
