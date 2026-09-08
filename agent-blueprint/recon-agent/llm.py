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

    A prefix of the reply is not enough detail: a reply truncated at the model's token cap and a
    genuinely malformed one both look like a short prefix, and they need opposite fixes (raise the cap
    versus fix the prompt). The length, the explicit unterminated flag and the tail tell them apart at
    a glance.

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


# Attributes the deterministic tier stamps onto the item before dispatching it. They belong in the
# INVESTIGATION prompt as an explicit, catalog-validated hint — but NOT in the classification
# prompt: `consistency` is only an independent signal if the classifier samples without being handed
# an answer first, and the serialized item would otherwise smuggle the hint in through the back door.
TIER1_HINT_KEYS = ("tier1_break_type", "tier1_escalation_reason")


def _item_summary(item: ReconItem, *, include_tier1_hint: bool) -> str:
    """Compact JSON view of the item for prompts (includes IDP-extracted fields).

    :param item: the reconciliation item to serialize.
    :param include_tier1_hint: keep Tier-1's stamped ``tier1_*`` attributes or drop them. Required
        with no default on purpose — getting it wrong is invisible in the output but silently turns
        self-consistency into agreement-with-Tier-1, so every call site has to state its intent.
        False for classification; True for investigation, where the hint is deliberate.
    :returns: pretty-printed JSON, truncated to 8000 characters.
    """
    data = item.model_dump()
    if not include_tier1_hint:
        attributes = data.get("attributes")
        if isinstance(attributes, dict):
            # Rebuilt rather than popped: model_dump may hand back the item's own nested dict, and
            # mutating it would strip the hint from the investigation prompt too.
            data["attributes"] = {k: v for k, v in attributes.items() if k not in TIER1_HINT_KEYS}
    return json.dumps(data, default=str, indent=2)[:8000]


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
) -> tuple[str, str]:
    """Self-consistency classification: sample the classifier ``samples`` times and majority-vote.

    Agreement across independent samples is a far better-calibrated signal than the model's
    stated confidence (consistency-based methods outperform verbalized/logit proxies in
    black-box settings). Sampling runs at temperature 0.7 for diversity, and each sample is an
    independent single-turn Strands call (see ``_default_json_caller``).

    That is why the vote survives while both numbers it used to produce are gone: it is what makes
    the PICK stable, and the pick selects the scoring denominator. Neither number is returned —
    the agreement fraction is NOT a gate (design D5: a 3-sample fraction has four possible values
    and no calibration study behind it, which is exactly how the deleted 0.6 floor started), and the
    model is no longer asked how sure it is at all.

    :param model_id: model or inference-profile id.
    :param system: system prompt text (the shared policy core).
    :param item: the reconciliation item being classified.
    :param catalog: the live SKILL.md catalog — the classification-type registry.
    :param lessons: prior analyst lessons to weight, or None.
    :param samples: how many independent samples to draw.
    :param caller: test seam forwarded to ``strands_json``; production leaves it None.
    :returns: (majority_class, majority_reasoning) — the reasoning is taken from a sample that voted
        with the majority, so it explains the class actually returned.
    """
    types = "\n".join(f"- {c['name']}: {c['description']}" for c in catalog)
    prompt = (
        "Classify this reconciliation item into exactly ONE of the types below.\n\n"
        # Tier-1's suggestion is withheld here so the three samples are genuinely independent of it;
        # the investigation prompt shows it, and the agent is free to disagree there.
        f"Types:\n{types}\n\nItem:\n{_item_summary(item, include_tier1_hint=False)}\n"
        f"{_lessons_block(lessons)}\n"
        # The reasoning length is bounded on purpose: an unbounded paragraph is what pushes the
        # reply into the token cap, and a truncated reply is unparseable JSON.
        'Reply with ONLY a JSON object: {"name": "<type name>", '
        '"reasoning": "<2-3 sentences explaining why, under 500 characters>"}'
    )
    votes: list[tuple[str, str]] = []
    for _ in range(samples):
        d = strands_json(
            model_id=model_id, system=system, prompt=prompt, temperature=0.7, caller=caller
        )
        votes.append((str(d["name"]), str(d["reasoning"])))
    tally: dict[str, int] = {}
    for name, _ in votes:
        tally[name] = tally.get(name, 0) + 1
    majority = max(tally, key=lambda k: tally[k])
    majority_votes = [v for v in votes if v[0] == majority]
    reasoning = majority_votes[0][1]
    return majority, reasoning


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


def _matched_notice_id(rows: list[dict] | None) -> str | None:
    """Derive the single notice_id the search_notices results matched.

    :param rows: notice rows recorded across the investigation.
    :returns: the sole distinct notice_id, or None when 0 or >1 were observed.
    """
    from backend.recon_core.proposal_service import derive_reference

    return derive_reference(str(r.get("notice_id")) for r in (rows or []) if r.get("notice_id"))


# Statuses the agent may propose — mirrors set_draw_status's allowlist so the model can't
# drive an out-of-domain state onto the ledger.
PROPOSABLE_STATUSES = ("Cancelled", "Confirmed", "OnHold", "Amended")
