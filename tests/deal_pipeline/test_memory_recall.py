"""Edge-case memory recall is advisory: it returns ids and text, and never fails the parse."""

from backend.deal_pipeline.memory_recall import retrieve_rules
from tests.fakes.memory import FakeMemoryClient


def test_returns_record_ids_and_text_and_skips_empty_records():
    client = FakeMemoryClient(
        response={
            "memoryRecordSummaries": [
                {
                    "memoryRecordId": "mem-1",
                    "content": {"text": "Project-finance TLBs are First Lien."},
                },
                {"memoryRecordId": "mem-2", "content": {}},
                {
                    "memoryRecordId": "mem-3",
                    "content": {"text": "Cov-lite means Covenant Status 3."},
                },
            ]
        }
    )
    hits = retrieve_rules(
        "mem-id", "deal-pipeline/edge-cases/deal-desk", "Cascade project finance", client=client
    )
    assert hits == [
        {"record_id": "mem-1", "text": "Project-finance TLBs are First Lien."},
        {"record_id": "mem-3", "text": "Cov-lite means Covenant Status 3."},
    ]
    call = client.calls[0]
    assert call["memoryId"] == "mem-id"
    assert call["namespace"] == "deal-pipeline/edge-cases/deal-desk"
    assert call["searchCriteria"] == {"searchQuery": "Cascade project finance", "topK": 6}


def test_query_is_truncated_to_the_api_limit():
    client = FakeMemoryClient()
    retrieve_rules("mem-id", "ns", "x" * 5000, top_k=3, client=client)
    assert len(client.calls[0]["searchCriteria"]["searchQuery"]) == 1000
    assert client.calls[0]["searchCriteria"]["topK"] == 3


def test_disabled_without_memory_id_or_query():
    client = FakeMemoryClient([{"record_id": "x", "text": "y"}])
    assert retrieve_rules("", "ns", "query", client=client) == []
    assert retrieve_rules("mem-id", "ns", "   ", client=client) == []
    assert client.calls == []


def test_fail_soft_on_service_errors():
    client = FakeMemoryClient(error=RuntimeError("throttled"))
    assert retrieve_rules("mem-id", "ns", "query", client=client) == []
