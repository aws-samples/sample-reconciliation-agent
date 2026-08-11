"""Tests for the Recon Agent core logic (reconcile_item) with injected fakes."""

from agent import reconcile_item


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
        _classify=lambda c: ("unknown", 0.9, "no strong signal"),
        _investigate=lambda it, s: ("resolve", 0.9, []),
        _skills=[],
    )
    assert out["item_id"] == "i-1"
    assert out["confidence"] == 0.9
    assert out["classification_reasoning"] == "no strong signal"
    assert out["status"] == "PROPOSED"
