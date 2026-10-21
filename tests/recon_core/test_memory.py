"""AgentCore Memory recall shared by both apps: shape, limits, and the fail-soft direction."""

import logging

from backend.recon_core.memory import retrieve_records
from tests.fakes.memory import FakeMemoryClient


def test_returns_record_ids_and_text_and_drops_textless_records():
    client = FakeMemoryClient(
        response={
            "memoryRecordSummaries": [
                {"memoryRecordId": "r-1", "content": {"text": "first"}},
                {"memoryRecordId": "r-2", "content": {}},
                {"memoryRecordId": "r-3"},
                {"content": {"text": "no id"}},
            ]
        }
    )
    hits = retrieve_records(
        "mem-1", "reconciliation/lessons/cash", "repricing", top_k=5, client=client
    )
    assert hits == [{"record_id": "r-1", "text": "first"}, {"record_id": "", "text": "no id"}]
    assert client.calls == [
        {
            "memoryId": "mem-1",
            "namespace": "reconciliation/lessons/cash",
            "searchCriteria": {"searchQuery": "repricing", "topK": 5},
        }
    ]


def test_query_is_truncated_to_the_api_limit_and_top_k_is_passed_through():
    client = FakeMemoryClient()
    retrieve_records("mem-1", "ns", "x" * 5000, top_k=3, client=client)
    assert len(client.calls[0]["searchCriteria"]["searchQuery"]) == 1000
    assert client.calls[0]["searchCriteria"]["topK"] == 3


def test_no_memory_id_means_no_call():
    client = FakeMemoryClient(["a lesson"])
    assert retrieve_records("", "ns", "query", top_k=5, client=client) == []
    assert client.calls == []


def test_fail_soft_on_service_errors_with_a_warning_naming_the_namespace(caplog):
    # Memories are advisory: a throttle must never fail the run that asked for them.
    client = FakeMemoryClient(error=RuntimeError("throttled"))
    with caplog.at_level(logging.WARNING, logger="backend.recon_core.memory"):
        assert (
            retrieve_records("mem-1", "deal-pipeline/edge-cases/x", "q", top_k=6, client=client)
            == []
        )
    assert (
        "memory recall failed (memory mem-1, namespace deal-pipeline/edge-cases/x)" in caplog.text
    )
    assert "throttled" in caplog.text


def test_fail_soft_when_the_client_cannot_be_built(monkeypatch):
    import boto3

    def explode(*_args, **_kwargs):
        raise RuntimeError("no endpoint")

    monkeypatch.setattr(boto3, "client", explode)
    assert retrieve_records("mem-1", "ns", "q", top_k=5) == []
