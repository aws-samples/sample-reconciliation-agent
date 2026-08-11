"""Computed composite confidence for agent proposals.

The model's self-reported ("verbalized") confidence is known to be poorly calibrated, so the
value that drives auto-resolution is a COMPUTED composite of three signals (research:
consistency-based methods outperform verbalized/logit proxies in black-box settings):

- **classification confidence** (weight 0.45): how sure the pipeline is of the break's class.
- **evidence grounding** (weight 0.35): fraction of cited evidence values that literally
  appear in the item's data — catches hallucinated support deterministically.
- **verbalized** (weight 0.20): the model's own stated confidence, kept as a weak signal.

If IDP flagged low-confidence extracted fields, the composite is shaved by 10% — the agent is
reasoning over data IDP itself was unsure about.

**Backend-agnostic by design.** Both agent backends use the SAME weights and the SAME formula
(``_composite``); they differ ONLY in the *source* of the classification-confidence signal,
which is unavoidable because the two backends classify differently:

- **runtime**: k-sample self-consistency (agreement across independent classification samples).
- **harness**: IDP's per-field extraction confidence, aggregated over the fields IDP actually
  populated (``backend/idp_hook/explainability.py``). Note the deliberate semantic shift: IDP does
  **not** emit a ``document_class.confidence``, so on this path the slot measures confidence in the
  *data the agent reasoned over* rather than in the class label — which is the better fit anyway,
  since the harness's class label comes from the model (``submit_proposal.class_name``), never from
  IDP. Both readings are "confidence in the inputs to the proposal", which is what the 0.45 weight
  buys. See the harness signal + tool-parity design record (D2).

When the classification signal is unavailable, the remaining two weights are renormalized
identically on both paths (grounding → 0.35/0.55, verbalized → 0.20/0.55 of the composite —
i.e. 0.636 x grounding + 0.364 x verbalized; see W_* below). This guarantees
that, given the same classification confidence / grounding / verbalized inputs, both backends
compute the identical score.
"""

import json
import re

from backend.recon_core.schema import ReasoningStep, ReconItem

# Single shared weight set — identical across both backends.
W_CLASSIFICATION = 0.45
W_GROUNDING = 0.35
W_VERBALIZED = 0.20
IDP_ALERT_PENALTY = 0.9

# Backwards-compatible aliases (older imports referenced W_CONSISTENCY / W_IDP). The runtime's
# "consistency" and the harness's "idp" are the SAME classification-confidence slot now.
W_CONSISTENCY = W_CLASSIFICATION
W_IDP = W_CLASSIFICATION
W_GROUNDING_IDP = W_GROUNDING
W_VERBALIZED_IDP = W_VERBALIZED

# When the classification signal is absent, its 0.45 weight has nothing to carry it, so
# grounding + verbalized are renormalized to keep the composite spanning [0, 1]. Same on both
# paths: grounding gets 0.35/(0.35+0.20) = 0.6363…, verbalized gets 0.20/0.55 = 0.3636….
_NO_CLASS_DENOM = W_GROUNDING + W_VERBALIZED
W_GROUNDING_NO_CLASS = W_GROUNDING / _NO_CLASS_DENOM
W_VERBALIZED_NO_CLASS = W_VERBALIZED / _NO_CLASS_DENOM
# Aliases used by the harness renormalization path — identical values, kept for call-site clarity.
W_GROUNDING_NO_IDP = W_GROUNDING_NO_CLASS
W_VERBALIZED_NO_IDP = W_VERBALIZED_NO_CLASS


def _normalize(s: str) -> str:
    """Lowercase and strip everything except alphanumerics so formatting noise
    (commas in amounts, spacing, case) doesn't count as a mismatch."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def grounding_fraction(*, evidence: list[str], haystack: str) -> float:
    """Fraction of cited evidence values that appear (normalized) in ``haystack``.

    Shared core of evidence grounding. Each evidence string is split on ':'/'=' and its VALUE
    part (or the whole string) is checked. Empty evidence scores 0.0 — an unverifiable proposal
    must not look trustworthy.

    :param evidence: cited evidence strings.
    :param haystack: the text the evidence must be grounded in (already RAW; normalized here).
    :returns: grounded fraction in [0, 1].
    """
    hay = _normalize(haystack)
    if not evidence:
        return 0.0
    grounded = 0
    for ev in evidence:
        value = re.split(r"[:=]", ev, maxsplit=1)[-1]
        needle = _normalize(value) or _normalize(ev)
        if needle and needle in hay:
            grounded += 1
    return grounded / len(evidence)


def evidence_grounding(*, item: ReconItem, steps: list[ReasoningStep]) -> float:
    """Fraction of cited evidence values that actually appear in the item's data.

    Each evidence string is split on ':'/'=' and its VALUE part (or the whole string) is
    checked, normalized, against the normalized item JSON. No evidence at all is scored 0.0 —
    an unverifiable proposal must not look trustworthy.

    :param item: the reconciliation item (its full JSON is the haystack).
    :param steps: the agent's reasoning steps carrying cited evidence.
    :returns: grounded fraction in [0, 1].
    """
    haystack = json.dumps(item.model_dump(), default=str)
    cited: list[str] = [e for s in steps for e in (s.evidence or [])]
    return grounding_fraction(evidence=cited, haystack=haystack)


def _composite(
    *, classification: float | None, grounding: float, verbalized: float, idp_alerts: int
) -> float:
    """The single, backend-agnostic composite formula both paths use.

    :param classification: classification-confidence signal in [0, 1] (runtime: self-consistency;
        harness: IDP assessment confidence), or None when unavailable → renormalize the other two.
    :param grounding: evidence-grounding fraction.
    :param verbalized: the model's stated overall confidence.
    :param idp_alerts: count of low-confidence IDP fields (any > 0 applies the 10% penalty).
    :returns: composite confidence, clamped to [0, 1].
    """
    if classification is None:
        c = W_GROUNDING_NO_CLASS * grounding + W_VERBALIZED_NO_CLASS * verbalized
    else:
        c = (
            W_CLASSIFICATION * classification
            + W_GROUNDING * grounding
            + W_VERBALIZED * verbalized
        )
    if idp_alerts:
        c *= IDP_ALERT_PENALTY
    return max(0.0, min(1.0, c))


def composite_confidence(
    *, consistency: float, grounding: float, verbalized: float, idp_alerts: int = 0
) -> float:
    """Runtime-path composite: classification signal = k-sample self-consistency.

    Thin wrapper over :func:`_composite` so both backends share ONE formula/weights — see the
    module docstring. Kept for the runtime call site + existing tests.

    :param consistency: classification agreement fraction across samples.
    :param grounding: evidence-grounding fraction.
    :param verbalized: the model's stated overall confidence.
    :param idp_alerts: count of low-confidence IDP fields (any > 0 applies the penalty).
    :returns: composite confidence, clamped to [0, 1].
    """
    return _composite(
        classification=consistency,
        grounding=grounding,
        verbalized=verbalized,
        idp_alerts=idp_alerts,
    )


def composite_confidence_idp(
    *,
    idp_confidence: float | None,
    grounding: float,
    verbalized: float,
    idp_alerts: int = 0,
) -> float:
    """Composite confidence for the HARNESS path: classification signal = IDP confidence.

    IDENTICAL formula and weights to the runtime path (:func:`composite_confidence`) — the only
    difference is the *source* of the classification-confidence signal (IDP's assessment score
    instead of self-consistency), which is unavoidable because the harness has no k-sample loop.
    So ``0.45·idp + 0.35·grounding + 0.20·verbalized``; when IDP confidence is absent (``None``)
    the classification term drops and grounding/verbalized renormalize exactly as on the runtime
    path. A low-confidence IDP alert shaves 10% (same as runtime).

    :param idp_confidence: IDP classification confidence in [0, 1], or None when unavailable.
    :param grounding: evidence-grounding fraction.
    :param verbalized: the model's stated overall confidence.
    :param idp_alerts: count of low-confidence IDP fields (any > 0 applies the penalty).
    :returns: composite confidence, clamped to [0, 1].
    """
    return _composite(
        classification=idp_confidence,
        grounding=grounding,
        verbalized=verbalized,
        idp_alerts=idp_alerts,
    )
