"""Tests for the case status enum and transition guard."""

from backend.recon_core.status import CaseStatus, can_transition


def test_valid_and_invalid_transitions():
    """The state machine allows the recon flow and forbids illegal jumps."""
    assert can_transition(CaseStatus.PENDING, CaseStatus.IN_PROGRESS)  # agent picks up
    assert can_transition(CaseStatus.IN_PROGRESS, CaseStatus.PROPOSED)  # agent proposes
    assert can_transition(CaseStatus.PROPOSED, CaseStatus.APPROVED)
    assert can_transition(CaseStatus.PENDING, CaseStatus.AUTO_CLEARED)  # tier-1 auto (terminal)
    assert not can_transition(CaseStatus.PENDING, CaseStatus.PROPOSED)  # must go via IN_PROGRESS
    assert not can_transition(CaseStatus.AUTO_CLEARED, CaseStatus.RESOLVED)  # AUTO_CLEARED terminal
    assert not can_transition(CaseStatus.RESOLVED, CaseStatus.PENDING)


def test_failed_is_reachable_only_from_in_progress_and_is_retryable():
    """A dead investigation escalates to FAILED, and FAILED can be retried rather than being terminal.

    Both halves matter. Reachable only from IN_PROGRESS: FAILED describes a run that started and
    died, which is the one state nothing else will ever move (only the agent writes PROPOSED).
    Retryable: the causes are mostly transient, so making it terminal would force an analyst to
    re-submit the item by hand.
    """
    assert can_transition(CaseStatus.IN_PROGRESS, CaseStatus.FAILED)
    assert can_transition(CaseStatus.FAILED, CaseStatus.IN_PROGRESS)  # retry
    assert can_transition(CaseStatus.FAILED, CaseStatus.CLOSED_NO_ACTION)  # give up
    assert can_transition(CaseStatus.FAILED, CaseStatus.AGED)
    # A case that reached a real verdict is never rewritten as a failure.
    for src in (
        CaseStatus.PENDING,
        CaseStatus.PROPOSED,
        CaseStatus.APPROVED,
        CaseStatus.REJECTED,
        CaseStatus.RESOLVED,
        CaseStatus.AUTO_CLEARED,
        CaseStatus.CLOSED_NO_ACTION,
        CaseStatus.AGED,
    ):
        assert not can_transition(src, CaseStatus.FAILED), src
    # FAILED is not a shortcut into the approval flow: a retry has to produce a new proposal.
    assert not can_transition(CaseStatus.FAILED, CaseStatus.PROPOSED)
    assert not can_transition(CaseStatus.FAILED, CaseStatus.RESOLVED)


def test_reject_outcomes():
    """From REJECTED a case can re-investigate, terminally close, or age out at the cap."""
    assert can_transition(CaseStatus.REJECTED, CaseStatus.IN_PROGRESS)  # re-process
    assert can_transition(CaseStatus.REJECTED, CaseStatus.CLOSED_NO_ACTION)  # no further action
    assert can_transition(CaseStatus.REJECTED, CaseStatus.AGED)  # re-process cap reached
    assert not can_transition(CaseStatus.CLOSED_NO_ACTION, CaseStatus.IN_PROGRESS)  # terminal
    assert not can_transition(CaseStatus.AGED, CaseStatus.IN_PROGRESS)  # terminal
