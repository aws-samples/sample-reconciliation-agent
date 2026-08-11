"""Tests for lessons recall from AgentCore Memory (fail-soft semantic retrieval)."""

from backend.recon_core.lessons_recall import retrieve_lessons


class _FakeMemory:
    """Canned retrieve_memory_records client; records the request."""

    def __init__(self, records=None, error=None):
        self._records = records or []
        self._error = error
        self.requests = []

    def retrieve_memory_records(self, **kw):
        self.requests.append(kw)
        if self._error:
            raise self._error
        return {"memoryRecordSummaries": [{"content": {"text": r}} for r in self._records]}


def test_retrieves_lessons_for_the_domain_namespace():
    fb = _FakeMemory(records=["PIK rate applies Q1", "prefer facility-level match"])
    out = retrieve_lessons(
        memory_id="mem-1", domain="cash", query="repricing notice", client=fb
    )
    assert out == ["PIK rate applies Q1", "prefer facility-level match"]
    req = fb.requests[0]
    assert req["memoryId"] == "mem-1"
    assert req["namespace"] == "reconciliation/lessons/cash"
    assert req["searchCriteria"]["searchQuery"] == "repricing notice"


def test_fail_soft_on_error_and_missing_memory_id():
    # Memory errors must never break the agent run — lessons are advisory context.
    fb = _FakeMemory(error=RuntimeError("throttled"))
    assert retrieve_lessons(memory_id="mem-1", domain="cash", query="x", client=fb) == []
    # No memory configured -> no call, empty result.
    assert retrieve_lessons(memory_id="", domain="cash", query="x", client=fb) == []
