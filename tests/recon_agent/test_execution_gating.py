"""Confidence-gated autonomous execution: execute the write only when the composite clears the
threshold AND there is a clean action; otherwise halt/escalate. Failures never resolve."""

from backend.recon_core.schema import Proposal
from backend.recon_core.auto_resolve import autonomous_execute
from gateway_mcp import ToolDenied


def _proposal(*, confidence: float, action) -> Proposal:
    return Proposal(
        item_id="idp-1",
        class_id="document-cross-reference",
        classification_reasoning="draw cancellation",
        resolution="Mark cancelled.",
        confidence=confidence,
        proposed_action=action,
    )


ACTION = {"tool": "set_draw_status", "reference": "DDTL-A-0001", "status": "Cancelled", "reason": "pushed"}


def test_executes_when_above_threshold_with_action():
    calls = []
    prop = _proposal(confidence=0.97, action=ACTION)
    outcome = autonomous_execute(
        proposal=prop, threshold=0.95, invoker=lambda a: calls.append(a) or {"status": "Cancelled"}
    )
    assert outcome == "executed"
    # The invoker receives the action WITH the composite confidence injected as an INTEGER
    # PERCENT (Cedar gates on Longs, not floats) — 0.97 → 97.
    assert calls == [{**ACTION, "confidence": 97}]
    exec_steps = [s for s in prop.steps if s.kind == "execute"]
    assert len(exec_steps) == 1
    assert exec_steps[0].outcome == "executed"
    assert exec_steps[0].action == ACTION


def test_policy_denial_escalates_not_fails():
    def deny(_action):
        raise ToolDenied("confidence below threshold")

    prop = _proposal(confidence=0.97, action=ACTION)  # app passed the gate, but policy denies
    outcome = autonomous_execute(proposal=prop, threshold=0.95, invoker=deny)
    assert outcome == "escalated"
    exec_steps = [s for s in prop.steps if s.kind == "execute"]
    assert exec_steps[0].outcome.startswith("escalated: policy denied")


def test_below_threshold_does_not_execute():
    calls = []
    prop = _proposal(confidence=0.80, action=ACTION)
    outcome = autonomous_execute(proposal=prop, threshold=0.95, invoker=lambda a: calls.append(a))
    assert outcome == "escalated"
    assert calls == []  # no write below threshold
    assert not [s for s in prop.steps if s.kind == "execute"]


def test_threshold_disabled_never_executes():
    calls = []
    prop = _proposal(confidence=0.99, action=ACTION)
    outcome = autonomous_execute(proposal=prop, threshold=None, invoker=lambda a: calls.append(a))
    assert outcome == "escalated"
    assert calls == []


def test_missing_action_escalates_even_when_confident():
    calls = []
    prop = _proposal(confidence=0.99, action=None)
    outcome = autonomous_execute(proposal=prop, threshold=0.95, invoker=lambda a: calls.append(a))
    assert outcome == "escalated"
    assert calls == []  # nothing safely executable


def test_write_failure_escalates_with_failed_outcome():
    def boom(_action):
        raise RuntimeError("ddb throttled")

    prop = _proposal(confidence=0.97, action=ACTION)
    outcome = autonomous_execute(proposal=prop, threshold=0.95, invoker=boom)
    assert outcome == "failed"
    exec_steps = [s for s in prop.steps if s.kind == "execute"]
    assert len(exec_steps) == 1
    assert exec_steps[0].outcome.startswith("failed:")
    assert "ddb throttled" in exec_steps[0].outcome


# A transport that DEGRADES a failure into a returned {"error": ...} dict instead of raising must
# not be read as a completed write. gateway_mcp did exactly that for anyio-wrapped denials until
# 2026-08-09, so "the invoker didn't raise" was never proof the ledger changed.


def test_returned_error_dict_is_a_failure_not_an_execution():
    prop = _proposal(confidence=0.97, action=ACTION)
    outcome = autonomous_execute(
        proposal=prop,
        threshold=0.95,
        invoker=lambda _a: {"error": "unhandled errors in a TaskGroup (1 sub-exception)"},
    )
    assert outcome == "failed"  # NOT "executed" — nothing was written
    exec_steps = [s for s in prop.steps if s.kind == "execute"]
    assert exec_steps[0].outcome.startswith("failed:")
    assert "TaskGroup" in exec_steps[0].outcome


def test_returned_denied_dict_escalates_as_a_denial():
    prop = _proposal(confidence=0.97, action=ACTION)
    outcome = autonomous_execute(
        proposal=prop,
        threshold=0.95,
        invoker=lambda _a: {"error": "policy denied the write", "denied": True},
    )
    assert outcome == "escalated"
    exec_steps = [s for s in prop.steps if s.kind == "execute"]
    assert exec_steps[0].outcome.startswith("escalated: policy denied")
    assert "policy denied the write" in exec_steps[0].outcome


def test_successful_result_payload_is_still_an_execution():
    """The guard keys on `error` only — a normal tool payload must not be misread as a failure."""
    prop = _proposal(confidence=0.97, action=ACTION)
    outcome = autonomous_execute(
        proposal=prop,
        threshold=0.95,
        invoker=lambda _a: {"reference": "DDTL-A-0001", "status": "Cancelled", "updated": True},
    )
    assert outcome == "executed"
