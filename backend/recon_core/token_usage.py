"""Fold a run's raw token-usage reports into the shape stored on the case record.

**Why this lives in ``recon_core`` rather than in either agent backend.** Both Tier-2 backends write
this field, from SEPARATE DEPLOYMENT UNITS: the harness worker is a Lambda
(``backend/harness_agent/worker.py``) and the runtime investigator is an arm64 container
(``agent-blueprint/recon-agent/``). ``recon_core`` is the only code the two share, so it is the only
place a single definition can serve both. A copy in each would be two answers to "what does
``input_tokens`` count", and the case screen shows ONE number without saying which backend produced
it — so the divergence would be invisible exactly where it matters, in the cost figure derived from
these counts.

The raw keys are Bedrock's camelCase (``inputTokens`` …); the stored keys are snake_case. That
translation happens HERE, once, for the same reason.
"""

from decimal import Decimal

# Raw Bedrock usage key -> the snake_case key stored on the case record. Any other key a provider
# reports (e.g. ``totalTokens``) is deliberately ignored: it is derivable from these four, and a
# stored total that could disagree with its own parts is worse than no total.
_KEY_MAP: dict[str, str] = {
    "inputTokens": "input_tokens",
    "outputTokens": "output_tokens",
    "cacheReadInputTokens": "cache_read_tokens",
    "cacheWriteInputTokens": "cache_write_tokens",
}

# Which backend measured the usage. Stored because the two paths have different fidelity — the
# harness reports one usage block per InvokeHarness turn, the runtime one per model call — so a
# reader comparing two cases has to know which kind of measurement each number is.
BACKENDS = ("harness", "runtime")


def _as_decimal(*, key: str, value: object) -> Decimal:
    """Coerce one raw count to ``Decimal``.

    ``Decimal``, never ``float``: boto3's DynamoDB resource raises ``TypeError`` on a Python float,
    so a float here would fail at runtime on every real write while every dict-level unit test on
    this function passed. Same rule as ``recon_core.notices.Notice``'s amount fields.

    :param key: the raw usage key, for the error message only.
    :param value: the raw count as it arrived on the wire.
    :returns: the count as a Decimal.
    :raises ValueError: when the value is not a number. Not defaulted to zero — a non-numeric count
        is a contract change in the stream, and zeroing it would report a free run.
    """
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError) as exc:
        raise ValueError(f"token usage {key}={value!r} is not a number") from exc


def summarize_token_usage(*, usages: list[dict], model_id: str, backend: str) -> dict | None:
    """Sum every turn's usage report into the token-usage shape stored on the case.

    Absence PROPAGATES, per key. A key no input dict carried is absent from the result too, never
    written as ``0``: "this model call reported no cache reads" and "this provider does not report
    cache reads at all" are different facts, and the case screen has to be able to tell them apart.
    A key SOME inputs carried is summed over those that did.

    Nothing measured at all — an empty list, or a list of dicts carrying none of the four counts —
    returns ``None``, which is the case record's "nobody measured this", again not a set of zeros.

    :param usages: every turn's raw usage dict, in call order. A LIST rather than one dict because
        both backends are multi-turn: taking the last turn's report instead of summing all of them
        undercounts every multi-turn case while a single-turn one still looks correct.
    :param model_id: the model the run ACTUALLY used (resolved config, never a deploy-time default).
        Stored because the cost is derived from it later.
    :param backend: which backend measured this — one of :data:`BACKENDS`.
    :returns: ``{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model_id,
        backend}`` with ``Decimal`` counts and only the keys that were actually reported, or ``None``
        when nothing was measured.
    :raises ValueError: on a blank ``model_id``, an unknown ``backend``, a usage entry that is not a
        dict, or a non-numeric count. All four are wiring bugs; a mislabelled or silently-zeroed
        usage record is mispriced with nothing downstream able to detect it.
    """
    if not str(model_id or "").strip():
        raise ValueError("summarize_token_usage requires the model id the run actually used")
    if backend not in BACKENDS:
        raise ValueError(f"backend must be one of {BACKENDS}, got {backend!r}")

    totals: dict[str, Decimal] = {}
    for usage in usages:
        if not isinstance(usage, dict):
            raise ValueError(
                f"each usage report must be a dict, got {type(usage).__name__}: {usage!r}"
            )
        for raw_key, stored_key in _KEY_MAP.items():
            # A key that is absent, or explicitly null, contributes nothing AND does not create the
            # stored key — that is the absence propagation the docstring promises. A key present on
            # ANY turn is created here and summed across the turns that carried it.
            if usage.get(raw_key) is None:
                continue
            totals[stored_key] = totals.get(stored_key, Decimal(0)) + _as_decimal(
                key=raw_key, value=usage[raw_key]
            )

    if not totals:
        return None
    return {**totals, "model_id": str(model_id), "backend": backend}
