"""Tests for the knowledge-base search tool Lambda (Gateway target)."""

from backend.kb_tool.handler import handle


class _FakeAgentRuntime:
    def __init__(self):
        self.request = None

    def retrieve(self, **kw):
        self.request = kw
        return {
            "retrievalResults": [
                {"content": {"text": "Timing breaks usually clear next day."}, "score": 0.82,
                 "location": {"s3Location": {"uri": "s3://assets/knowledge-base/guidance.md"}}},
            ]
        }


def test_handle_returns_passages(monkeypatch):
    monkeypatch.setenv("KB_ID", "KB123")
    fake = _FakeAgentRuntime()
    out = handle({"query": "how to resolve timing breaks", "top_k": 3}, None, client=fake)
    assert out["results"][0]["text"].startswith("Timing breaks")
    assert out["results"][0]["score"] == 0.82
    assert fake.request["knowledgeBaseId"] == "KB123"
    assert fake.request["retrievalConfiguration"]["vectorSearchConfiguration"]["numberOfResults"] == 3


def test_handle_requires_query():
    import pytest
    with pytest.raises(ValueError):
        handle({}, None, client=_FakeAgentRuntime())
