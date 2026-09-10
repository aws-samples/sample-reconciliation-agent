"""Case status enum and the allowed-transition guard for the reconciliation flow.

Tier-1 auto-resolutions land in AUTO_CLEARED (terminal). Escalated items flow
PENDING -> IN_PROGRESS -> PROPOSED -> APPROVED -> RESOLVED, with REJECTED looping back
to IN_PROGRESS for re-investigation. AUTO_CLEARED and RESOLVED are terminal.

An investigation that ERRORS lands in FAILED, which is retryable (FAILED -> IN_PROGRESS). FAILED
exists because only the agent writes the PROPOSED row: without it a runtime error leaves the case in
IN_PROGRESS forever, a queue entry that never advances and gives an analyst nothing to distinguish
"still thinking" from "died 40 minutes ago".
"""

from enum import Enum


class CaseStatus(str, Enum):
    """The lifecycle states of a reconciliation case."""

    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    PROPOSED = "PROPOSED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    RESOLVED = "RESOLVED"
    AUTO_CLEARED = "AUTO_CLEARED"
    AGED = "AGED"
    CLOSED_NO_ACTION = "CLOSED_NO_ACTION"  # analyst disapproved, no further action (terminal)
    FAILED = "FAILED"  # the investigation errored out; retryable, NOT terminal


# Allowed forward transitions per state. AUTO_CLEARED, RESOLVED, CLOSED_NO_ACTION are terminal.
_ALLOWED: dict[CaseStatus, set[CaseStatus]] = {
    CaseStatus.PENDING: {CaseStatus.IN_PROGRESS, CaseStatus.AUTO_CLEARED, CaseStatus.AGED},
    # From IN_PROGRESS: propose, age out, analyst-cancel a stuck investigation, or record that the
    # run errored. FAILED is reachable ONLY from IN_PROGRESS — it describes an investigation that
    # started and died, which is the only situation where nothing else will ever move the case.
    CaseStatus.IN_PROGRESS: {
        CaseStatus.PROPOSED,
        CaseStatus.AGED,
        CaseStatus.CLOSED_NO_ACTION,
        CaseStatus.FAILED,
    },
    # From FAILED: retry (back to IN_PROGRESS), give up terminally, or age out when the retry cap
    # is reached. Deliberately NOT terminal — most causes are transient (throttling, a token cap, a
    # tool outage), and the alternative is an analyst re-submitting the item by hand.
    CaseStatus.FAILED: {CaseStatus.IN_PROGRESS, CaseStatus.CLOSED_NO_ACTION, CaseStatus.AGED},
    CaseStatus.PROPOSED: {CaseStatus.APPROVED, CaseStatus.REJECTED},
    CaseStatus.APPROVED: {CaseStatus.RESOLVED},
    # From REJECTED: re-process (IN_PROGRESS), terminally close (CLOSED_NO_ACTION), or age out
    # when the re-process cap is reached (AGED).
    CaseStatus.REJECTED: {CaseStatus.IN_PROGRESS, CaseStatus.CLOSED_NO_ACTION, CaseStatus.AGED},
}


def can_transition(src: CaseStatus, dst: CaseStatus) -> bool:
    """Return True if src->dst is an allowed case-state transition."""
    return dst in _ALLOWED.get(src, set())
