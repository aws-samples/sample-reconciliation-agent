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


def test_reject_outcomes():
    """From REJECTED a case can re-investigate, terminally close, or age out at the cap."""
    assert can_transition(CaseStatus.REJECTED, CaseStatus.IN_PROGRESS)  # re-process
    assert can_transition(CaseStatus.REJECTED, CaseStatus.CLOSED_NO_ACTION)  # no further action
    assert can_transition(CaseStatus.REJECTED, CaseStatus.AGED)  # re-process cap reached
    assert not can_transition(CaseStatus.CLOSED_NO_ACTION, CaseStatus.IN_PROGRESS)  # terminal
    assert not can_transition(CaseStatus.AGED, CaseStatus.IN_PROGRESS)  # terminal
