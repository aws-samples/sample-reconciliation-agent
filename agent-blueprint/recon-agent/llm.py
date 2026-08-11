"""Strands-backed classify/investigate callables for the recon agent.

`classifier.pick_class` and `proposal.build_proposal` take injected callables. This module
builds the production versions: prompts assembled from the live SKILL.md catalog + the item's
data (including the IDP-extracted fields in item.attributes), answered through the **Strands
SDK** (`strands.Agent` over a `BedrockModel`), with strict JSON replies parsed by `extract_json`.

Every Bedrock call this container makes goes through Strands — there is no direct
`bedrock-runtime` client left — and every `BedrockModel` is built with ``streaming=False``, so the
wire API is `Converse`, never `ConverseStream`.
"""

import json
import logging

from backend.recon_core.schema import ReconItem

logger = logging.getLogger(__name__)


def _object_end(text: str, start: int) -> int | None:
    """Find the end of the balanced JSON object that starts at ``text[start]``.

    Brace counting has to be string-aware: a ``{`` or ``}`` inside a JSON string literal is
    ordinary text, not nesting. The classifier's ``reasoning`` field routinely quotes ledger
    payloads and dict-shaped snippets, and a naive counter treats the first embedded ``}`` as the
    end of the object — producing a substring that fails to parse and, once every opening brace
    has been tried that way, a bogus "no JSON object" error on a perfectly good reply. Escapes
    (``\\"``, ``\\\\``) are honoured so an escaped quote does not flip the in-string state.

    :param text: raw model reply.
    :param start: index of the opening ``{``.
    :returns: index one past the matching ``}``, or None when the object is never closed
        (i.e. the reply was cut off mid-object).
    """
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False  # this character is consumed by the preceding backslash
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
    return None


def _extract_failure(text: str, *, unterminated: bool) -> ValueError:
    """Build the ValueError for an unparseable reply, with enough detail to diagnose it.

    The old message showed only the first 200 characters, which made a reply truncated at the
    model's token cap indistinguishable from a malformed one — both looked like a short prefix.
    The length, the explicit unterminated flag and the tail tell them apart at a glance.

    :param text: raw model reply.
    :param unterminated: True when an opening brace was found but never balanced.
    :returns: the ValueError to raise.
    """
    cause = (
        "object never closed — the reply was cut off mid-object"
        if unterminated
        else "no balanced JSON object present"
    )
    detail = f"no JSON object in model reply: {cause}; {len(text)} chars; head={text[:200]!r}"
    if len(text) > 400:
        detail += f"; tail={text[-200:]!r}"
    return ValueError(detail)


def extract_json(text: str) -> dict:
    """Parse the first JSON object found in an LLM reply.

    Models sometimes wrap JSON in prose or code fences; scan for the first balanced ``{...}``
    block (ignoring braces inside string literals) and parse it. Raises ValueError when no
    parseable object exists — fail loudly rather than fabricate a result.

    :param text: raw model reply.
    :returns: the parsed JSON object.
    :raises ValueError: when the reply holds no parseable JSON object.
    """
    unterminated = False
    start = text.find("{")
    while start != -1:
        end = _object_end(text, start)
        if end is None:
            # Depth never returned to zero. Every later brace is nested inside this same
            # unclosed object, so there is nothing left to try.
            unterminated = True
            break
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass  # not JSON after all (e.g. prose braces); try the next opening brace
        start = text.find("{", start + 1)
    raise _extract_failure(text, unterminated=unterminated)


def _result_text(result) -> str:
    """Extract the assistant's final text from a Strands AgentResult (or a plain string).

    Shared by the classifier here and by ``strands_investigator`` — one implementation, because
    both parse the model's last message rather than using forced-tool ``structured_output``.

    :param result: a Strands ``AgentResult``, or a plain string.
    :returns: the concatenated text of the final assistant message.
    """
    if isinstance(result, str):
        return result
    msg = getattr(result, "message", None)
    if isinstance(msg, dict):
        return "".join(b.get("text", "") for b in msg.get("content", []) if isinstance(b, dict))
    return str(result)


def _default_json_caller(
    *,
    model_id: str,
    system: str,
    prompt: str,
    max_tokens: int,
    temperature: float | None,
) -> tuple[str, str]:  # pragma: no cover - thin Strands wiring, exercised via the `caller` seam
    """One Strands single-turn call, returning the raw reply text and its stop reason.

    A FRESH ``Agent`` per call, deliberately: a Strands ``Agent`` accumulates conversation state,
    so reusing one across self-consistency samples would make sample 2 a follow-up turn that has
    already seen sample 1's answer — collapsing the very independence the consistency signal
    measures. ``tools=[]`` because classification is a single-turn judgement, not an agentic loop,
    and ``callback_handler=None`` keeps the sampled replies out of the container's stdout.

    ``streaming=False`` pins the wire API to `Converse`; Strands' `BedrockModel` default is
    `ConverseStream`, which this container does not use.

    :param model_id: model or inference-profile id.
    :param system: system prompt text.
    :param prompt: user prompt text.
    :param max_tokens: response cap.
    :param temperature: sampling temperature, or None to omit it (models that deprecated it).
    :returns: (reply text, stop reason).
    """
    from strands import Agent
    from strands.models import BedrockModel

    config: dict = {"model_id": model_id, "streaming": False, "max_tokens": max_tokens}
    if temperature is not None:
        config["temperature"] = temperature
    agent = Agent(
        model=BedrockModel(**config), system_prompt=system, tools=[], callback_handler=None
    )
    result = agent(prompt)
    return _result_text(result), str(getattr(result, "stop_reason", "") or "")


# Model ids that reject `temperature` (e.g. Claude Sonnet 5 deprecated it and returns a
# ValidationException). Remembered after the first rejection so we only pay the retry once.
_NO_TEMPERATURE: set[str] = set()


def strands_json(
    *,
    model_id: str,
    system: str,
    prompt: str,
    max_tokens: int = 1500,
    temperature: float = 0.2,
    caller=None,
) -> dict:
    """One Strands model call returning the parsed JSON object from the reply.

    Newer models (e.g. Claude Sonnet 5) DEPRECATED the ``temperature`` inference parameter and
    reject it with a ValidationException. We include ``temperature`` when the model accepts it
    (so self-consistency sampling stays diverse on models like Nova) and transparently drop it —
    caching that per model id — for models that reject it, rather than crashing the invocation.

    A reply the model cut off at its token cap (``stop_reason == "max_tokens"``) is retried ONCE
    with double the cap and an explicit brevity instruction, because the truncated JSON is
    unparseable and a whole investigation would otherwise fail on a formatting accident. The
    retry is logged and bounded: if the second attempt is also unusable the error propagates.

    :param model_id: model or inference-profile id.
    :param system: system prompt text.
    :param prompt: user prompt text.
    :param max_tokens: response cap.
    :param temperature: sampling temperature (self-consistency sampling passes a higher one).
    :param caller: test seam — ``callable(*, model_id, system, prompt, max_tokens, temperature)
        -> (text, stop_reason)`` replacing the live Strands call. Production leaves it None.
    :returns: parsed JSON dict from the model reply.
    :raises ValueError: when the reply (after at most one retry) holds no parseable JSON object.
    """
    call = caller or _default_json_caller

    def _attempt(*, cap: int, user_text: str) -> tuple[str, str]:
        """One model call, transparently dropping `temperature` for models that reject it.

        :param cap: max_tokens for this attempt.
        :param user_text: the user message text.
        :returns: (reply text, stop reason).
        """
        want_temperature = model_id not in _NO_TEMPERATURE
        try:
            return call(
                model_id=model_id,
                system=system,
                prompt=user_text,
                max_tokens=cap,
                temperature=temperature if want_temperature else None,
            )
        except Exception as exc:  # noqa: BLE001 - retry without temperature if that's the cause
            if want_temperature and "temperature" in str(exc).lower():
                _NO_TEMPERATURE.add(model_id)  # remember: this model rejects temperature
                return call(
                    model_id=model_id,
                    system=system,
                    prompt=user_text,
                    max_tokens=cap,
                    temperature=None,
                )
            raise

    text, stop_reason = _attempt(cap=max_tokens, user_text=prompt)
    if stop_reason == "max_tokens":
        # The JSON is necessarily incomplete; parsing it can only raise. Ask again with room to
        # finish and an explicit brevity nudge so the second reply fits.
        logger.warning(
            "model hit the %d-token cap (stopReason=max_tokens, %d chars); retrying with %d",
            max_tokens,
            len(text),
            max_tokens * 2,
        )
        text, stop_reason = _attempt(
            cap=max_tokens * 2,
            user_text=(
                f"{prompt}\n\nIMPORTANT: reply with ONLY the JSON object and keep every string"
                " value under 500 characters, so the whole object fits in your reply."
            ),
        )
    return extract_json(text)


def _item_summary(item: ReconItem) -> str:
    """Compact JSON view of the item for prompts (includes IDP-extracted fields)."""
    return json.dumps(item.model_dump(), default=str, indent=2)[:8000]


def _lessons_block(lessons: list[str] | None) -> str:
    """Format prior analyst lessons as an advisory prompt block ('' when none)."""
    if not lessons:
        return ""
    joined = "\n".join(f"- {le}" for le in lessons)
    return (
        "\nLessons from prior analyst decisions on similar items (authoritative — weight"
        f" these heavily):\n{joined}\n"
    )


def classify_with_consistency(
    *,
    model_id: str,
    system: str,
    item: ReconItem,
    catalog: list[dict],
    lessons: list[str] | None = None,
    samples: int = 3,
    caller=None,
) -> tuple[str, float, str, float]:
    """Self-consistency classification: sample the classifier ``samples`` times and majority-vote.

    Agreement across independent samples is a far better-calibrated signal than the model's
    stated confidence (consistency-based methods outperform verbalized/logit proxies in
    black-box settings). Sampling runs at temperature 0.7 for diversity, and each sample is an
    independent single-turn Strands call (see ``_default_json_caller``).

    :param model_id: model or inference-profile id.
    :param system: system prompt text (the shared policy core).
    :param item: the reconciliation item being classified.
    :param catalog: the live SKILL.md catalog — the classification-type registry.
    :param lessons: prior analyst lessons to weight, or None.
    :param samples: how many independent samples to draw.
    :param caller: test seam forwarded to ``strands_json``; production leaves it None.
    :returns: (majority_class, mean_verbalized_confidence_of_majority, majority_reasoning,
        consistency = majority_votes / samples).
    """
    types = "\n".join(
        f"- {c['name']}: {c['description']}" for c in catalog
    )
    prompt = (
        "Classify this reconciliation item into exactly ONE of the types below.\n\n"
        f"Types:\n{types}\n\nItem:\n{_item_summary(item)}\n"
        f"{_lessons_block(lessons)}\n"
        # The reasoning length is bounded on purpose: an unbounded paragraph is what pushes the
        # reply into the token cap, and a truncated reply is unparseable JSON.
        'Reply with ONLY a JSON object: {"name": "<type name>", "confidence": <0..1>, '
        '"reasoning": "<2-3 sentences explaining why, under 500 characters>"}'
    )
    votes: list[tuple[str, float, str]] = []
    for _ in range(samples):
        d = strands_json(
            model_id=model_id, system=system, prompt=prompt, temperature=0.7, caller=caller
        )
        votes.append((str(d["name"]), float(d["confidence"]), str(d["reasoning"])))
    tally: dict[str, int] = {}
    for name, _, _ in votes:
        tally[name] = tally.get(name, 0) + 1
    majority = max(tally, key=lambda k: tally[k])
    majority_votes = [v for v in votes if v[0] == majority]
    verbalized = sum(v[1] for v in majority_votes) / len(majority_votes)
    reasoning = majority_votes[0][2]
    return majority, verbalized, reasoning, tally[majority] / samples


def _summarize_tool_output(result) -> str:
    """Compact one-line summary of a tool result for the trace (kept small for the UI)."""
    return json.dumps(result, default=str)[:600]


def _matched_reference(rows: list[dict]) -> str | None:
    """The single ledger reference a search_ledger call matched, or None if 0 or >1.

    Thin shape-adapter over the SHARED rule in ``recon_core.proposal_service`` (one
    implementation for both backends): exactly one distinct observed reference wins.
    """
    from backend.recon_core.proposal_service import derive_reference

    return derive_reference(str(r.get("reference")) for r in (rows or []) if r.get("reference"))


# Statuses the agent may propose — mirrors set_draw_status's allowlist so the model can't
# drive an out-of-domain state onto the ledger.
PROPOSABLE_STATUSES = ("Cancelled", "Confirmed", "OnHold", "Amended")
