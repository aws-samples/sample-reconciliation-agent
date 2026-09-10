"""Tier-1's break-type hint: where it lives on the item, and what to do when the agent disagrees.

Tier-1 classifies with a plain-Python rule table (``backend/tier1/classify.py``) that sees only the
item's SHAPE — how many sides it has, its domain — and stamps its guess onto the item's attribute bag
as ``tier1_break_type``. It is a HINT, never a decision. The classification recorded on the case is
always the agent's own: Tier-1 cannot see the SKILL.md catalog, so letting it decide would pin the
case to a vocabulary the catalog is free to change, and the agent's reasoning would then explain a
type it did not pick.

Both functions here are shared by BOTH Tier-2 backends on purpose. Four places read this hint — two
prompt builders (``strands_investigator._class_hint_block``, ``prompting._class_hint_line``) and two
classifiers (``classifier.pick_class``, ``intake._classify``) — and the failure mode being guarded
against is three of the four agreeing. One key, one disagreement rule, one log line.
"""

import logging

# The attribute Tier-1 stamps its guess onto. Spelled once; every reader imports it from here.
BREAK_TYPE_KEY = "tier1_break_type"

_LOG = logging.getLogger(__name__)


def read_hint(*, attributes: dict) -> str | None:
    """Read Tier-1's break-type guess off an item's attribute bag.

    Returns ``None`` rather than the raw value for anything unusable, so no caller has to re-check the
    type. Tier-1 omits the key entirely when its rules matched nothing, and the attribute bag is
    untrusted stored text — a manual submission or the Cases UI can put anything there, and it is
    heading for a model prompt.

    This does NOT check the hint against the catalog. The two prompt builders do (a class whose
    procedure the agent was not given is useless to it), but :func:`warn_on_disagreement` deliberately
    does not: a hint naming a break type the catalog no longer has is itself worth seeing.

    :param attributes: the item's attribute bag.
    :returns: the hinted break-type name, or None when absent, empty or not a string.
    """
    value = attributes.get(BREAK_TYPE_KEY)
    return value if isinstance(value, str) and value else None


def warn_on_disagreement(*, class_id: str, tier1_hint: str | None) -> None:
    """Log at WARNING when the agent's chosen class differs from Tier-1's hint. Advisory only.

    **Never overrules and never blocks.** The point is observability, not enforcement: Tier-1's rule
    table cannot see the catalog, so it is in no position to arbitrate.

    Why it is worth a WARNING at all: classification selects the scoring DENOMINATOR — the one skill
    whose prescribed required steps ``recon_core.confidence.score_proposal`` divides by. The shipped
    skills prescribe 4, 5 and 6 required steps, and the auto-resolve threshold means "all of them" for
    every one, so a mis-pick does not lower the bar — it swaps WHICH checks must be evidenced before
    an unattended ledger write. There is deliberately no self-reported confidence floor to catch a
    model unsure of its class (as a gate it was a mass false negative), and nothing else notices a
    mis-pick. Logging it is what makes the residual risk measurable instead of arguable.

    Silent when there is no hint: Tier-1 escalates plenty of items with no break type at all, and an
    every-item WARNING trains the operator to filter out the line, costing exactly the signal it
    exists to give.

    :param class_id: the class the agent picked — the one that reaches the case record.
    :param tier1_hint: Tier-1's guess from :func:`read_hint`, or None when it made none.
    :returns: None.
    """
    if tier1_hint and class_id != tier1_hint:
        _LOG.warning(
            "classification disagrees with %s: agent=%r tier1=%r — the agent's pick stands (Tier-1 "
            "cannot see the catalog), but it selects the scoring denominator, so this is the signal "
            "to watch if evidence completeness starts passing on the wrong checks",
            BREAK_TYPE_KEY,
            class_id,
            tier1_hint,
        )
