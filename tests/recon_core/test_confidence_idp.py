"""Harness-path composite confidence: now IDENTICAL weights to the runtime path (unified).

The classification signal (IDP's assessment confidence on this path) is weighted 0.45 — the
same slot self-consistency occupies on the runtime path — so both backends compute the same
score given the same inputs. See tests/recon_agent/test_confidence.py for the cross-backend
equivalence check.
"""

import pytest

from backend.recon_core.confidence import (
    composite_confidence,
    composite_confidence_idp,
)


def test_idp_present_weighted_blend():
    # Unified weights: 0.45*0.9 + 0.35*0.8 + 0.20*0.6 = 0.405 + 0.28 + 0.12 = 0.805
    c = composite_confidence_idp(idp_confidence=0.9, grounding=0.8, verbalized=0.6)
    assert c == pytest.approx(0.805)


def test_idp_absent_renormalizes_grounding_and_verbalized():
    # None IDP → renormalize 0.35/0.20 to 0.6363…/0.3636…: 0.63636*0.8 + 0.36364*0.6 = 0.72727
    c = composite_confidence_idp(idp_confidence=None, grounding=0.8, verbalized=0.6)
    assert c == pytest.approx(0.8 * (0.35 / 0.55) + 0.6 * (0.20 / 0.55))


def test_idp_alert_shaves_ten_percent():
    base = composite_confidence_idp(idp_confidence=0.9, grounding=0.8, verbalized=0.6)
    penalized = composite_confidence_idp(
        idp_confidence=0.9, grounding=0.8, verbalized=0.6, idp_alerts=2
    )
    assert penalized == pytest.approx(base * 0.9)


def test_clamped_to_unit_interval():
    # All-max inputs stay <= 1.0; all-zero stays >= 0.0.
    assert composite_confidence_idp(idp_confidence=1.0, grounding=1.0, verbalized=1.0) == 1.0
    assert composite_confidence_idp(idp_confidence=0.0, grounding=0.0, verbalized=0.0) == 0.0


def test_idp_absent_full_grounding_no_verbalized():
    # Pure grounding when IDP absent and verbalized is 0: renormalized grounding weight 0.6363….
    c = composite_confidence_idp(idp_confidence=None, grounding=1.0, verbalized=0.0)
    assert c == pytest.approx(0.35 / 0.55)


def test_both_backends_agree_for_same_inputs():
    """The whole point of unification: given the SAME classification/grounding/verbalized
    inputs, runtime (consistency) and harness (idp) compute the identical composite."""
    runtime = composite_confidence(consistency=0.9, grounding=0.8, verbalized=0.6, idp_alerts=1)
    harness = composite_confidence_idp(
        idp_confidence=0.9, grounding=0.8, verbalized=0.6, idp_alerts=1
    )
    assert runtime == pytest.approx(harness)
