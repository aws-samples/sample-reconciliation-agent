"""Tests for the Recon Agent core logic (reconcile_item) with injected fakes."""

from agent import reconcile_item
from backend.recon_core.schema import InvestigationResult


def test_entrypoint_returns_proposal_dict_for_escalated_item():
    payload = {
        "item": {
            "item_id": "i-1",
            "domain": "cash",
            "sides": [{"name": "bank"}, {"name": "ledger"}],
        }
    }
    out = reconcile_item(
        payload,
        _catalog=[
            {
                "name": "unknown",
                "confidence_threshold": 0.5,
                "severity": "LOW",
                "description": "x",
                "deterministic_eligible": False,
            }
        ],
        _classify=lambda c: ("unknown", "no strong signal"),
        _investigate=lambda it, s: InvestigationResult(resolution="resolve"),
        _skills=[],
    )
    assert out["item_id"] == "i-1"
    # `reconcile_item` does not score; `score_by_evidence` writes `confidence` from the trace.
    assert out["confidence"] == 0.0
    assert out["classification_reasoning"] == "no strong signal"
    assert out["status"] == "PROPOSED"
