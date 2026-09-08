"""Tier-1's break-type hint: one reader of one attribute key, and an advisory disagreement log.

The hint is read by four places across both Tier-2 backends (two prompt builders and two
classifiers), so the key and the disagreement rule live in one module — the failure mode being
guarded against is three of the four agreeing.
"""

import logging

from backend.recon_core.tier1_hint import read_hint, warn_on_disagreement


def test_a_real_hint_is_returned() -> None:
    assert (
        read_hint(attributes={"tier1_break_type": "record-match-review"}) == "record-match-review"
    )


def test_an_absent_or_unusable_hint_reads_as_none() -> None:
    """Each of these arrives in practice: Tier-1 omits the key when its rules matched nothing, and
    the attribute bag is untrusted stored text an older deploy or the Cases UI could have written.
    ``None`` for all of them means no caller has to re-check the type.
    """
    assert read_hint(attributes={}) is None
    assert read_hint(attributes={"tier1_break_type": ""}) is None
    assert read_hint(attributes={"tier1_break_type": 7}) is None
    assert read_hint(attributes={"tier1_break_type": None}) is None


def test_a_disagreement_is_logged_with_both_class_names(caplog) -> None:
    """Classification picks the scoring denominator, so a mis-pick swaps which evidence an unattended
    write requires — it does not lower the bar. Until 2026-09-04 a model unsure of its class
    self-reported low and the case escalated; nothing notices now, so the disagreement has to be
    observable for design D8's deferred cross-check to be decided on data instead of on argument.
    """
    with caplog.at_level(logging.WARNING):
        warn_on_disagreement(class_id="ledger-status-resolution", tier1_hint="record-match-review")
    assert "ledger-status-resolution" in caplog.text
    assert "record-match-review" in caplog.text


def test_agreement_logs_nothing(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        warn_on_disagreement(class_id="timing", tier1_hint="timing")
    assert caplog.text == ""


def test_no_hint_logs_nothing(caplog) -> None:
    """Tier-1 escalates plenty of items with no break type at all — an every-item WARNING would
    train the operator to filter this line out, which costs exactly the signal it exists to give.
    """
    with caplog.at_level(logging.WARNING):
        warn_on_disagreement(class_id="timing", tier1_hint=None)
    assert caplog.text == ""
