"""Tests for the debounced knowledge-base ingestion Lambda."""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from backend.kb_ingest import handler as kb


class _FakeAgent:
    """Stands in for the bedrock-agent client, recording what the handler asked for."""

    def __init__(self, *, jobs: list[dict[str, Any]], documents: list[str]) -> None:
        self.jobs = jobs
        self.documents = documents
        self.started = 0

    def list_ingestion_jobs(self, **_: Any) -> dict[str, Any]:
        return {"ingestionJobSummaries": self.jobs}

    def list_knowledge_base_documents(self, **_: Any) -> dict[str, Any]:
        return {
            "documentDetails": [
                {"identifier": {"s3": {"uri": uri}}, "status": "INDEXED"} for uri in self.documents
            ]
        }

    def start_ingestion_job(self, **_: Any) -> dict[str, Any]:
        self.started += 1
        return {"ingestionJob": {"ingestionJobId": "JOB-NEW"}}


class _FakeTable:
    """Stands in for the uploads table, holding rows in memory."""

    def __init__(self, *, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def query(self, **_: Any) -> dict[str, Any]:
        return {"Items": self.rows}

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        key = kwargs["Key"]["submission_id"]
        files = kwargs["ExpressionAttributeValues"][":files"]
        for row in self.rows:
            if row["submission_id"] == key:
                row["files"] = files
        return {}


def _row(*, keys: list[str], status: str, uploaded_at: str) -> dict[str, Any]:
    """Build one submission row with a file per key.

    ``status_updated_at`` is set to a deliberately much later time than ``uploaded_at``, and the
    gap is the point. A handler that compared job times against ``status_updated_at`` -- which it
    bumps itself on every pass -- would never conclude that a job had run after the upload, so
    ``test_fails_a_document_a_completed_job_did_not_index`` fails if the wrong attribute is read.
    """
    return {
        "submission_id": "sub-1",
        "route": "knowledge-base",
        "uploaded_at": uploaded_at,
        "status_updated_at": "2099-01-01T00:00:00Z",
        "files": [
            {"filename": k.rsplit("/", 1)[-1], "object_key": k, "status": status, "size_bytes": 1}
            for k in keys
        ],
    }


BUCKET = "recon-dev-assets"
KEY = "knowledge-base/uploads/2026/notice.pdf"
EVENT = {"Records": [{"messageId": "m1", "body": "{}"}]}


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the four variables the handler refuses to run without."""
    monkeypatch.setenv("KB_ID", "50K9JVEJTH")
    monkeypatch.setenv("KB_DATA_SOURCE_ID", "OKXCPEX5F6")
    monkeypatch.setenv("UPLOADS_TABLE", "recon-dev-idp-uploads")
    monkeypatch.setenv("ASSETS_BUCKET", BUCKET)


def test_starts_no_second_job_while_one_is_in_flight(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _FakeAgent(
        jobs=[{"status": "IN_PROGRESS", "startedAt": dt.datetime.now(dt.UTC)}], documents=[]
    )
    table = _FakeTable(
        rows=[_row(keys=[KEY], status="PENDING_INGESTION", uploaded_at="2026-09-02T10:00:00Z")]
    )
    monkeypatch.setattr(kb, "_agent", lambda: agent)
    monkeypatch.setattr(kb, "_table", lambda: table)

    result = kb.handler(EVENT, None)

    # StartIngestionJob errors while a job is in flight, so the messages go back to the queue
    # instead. Reporting them as failures is what re-drives them; swallowing them would leave the
    # upload PENDING_INGESTION forever with nothing scheduled to look at it again.
    assert agent.started == 0
    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}]}


def test_flips_a_present_document_to_ingested(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _FakeAgent(
        jobs=[{"status": "COMPLETE", "startedAt": dt.datetime(2026, 9, 2, 11, tzinfo=dt.UTC)}],
        documents=[f"s3://{BUCKET}/{KEY}"],
    )
    table = _FakeTable(
        rows=[_row(keys=[KEY], status="PENDING_INGESTION", uploaded_at="2026-09-02T10:00:00Z")]
    )
    monkeypatch.setattr(kb, "_agent", lambda: agent)
    monkeypatch.setattr(kb, "_table", lambda: table)

    result = kb.handler(EVENT, None)

    assert table.rows[0]["files"][0]["status"] == "INGESTED"
    # Nothing left pending, so no job is needed and the messages are done.
    assert agent.started == 0
    assert result == {"batchItemFailures": []}


def test_starts_a_job_for_a_document_no_job_has_seen_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    # The newest completed job started BEFORE the upload, so its absence from the corpus is
    # expected rather than a failure. This is the ordinary path: a file was just put.
    agent = _FakeAgent(
        jobs=[{"status": "COMPLETE", "startedAt": dt.datetime(2026, 9, 2, 9, tzinfo=dt.UTC)}],
        documents=[],
    )
    table = _FakeTable(
        rows=[_row(keys=[KEY], status="PENDING_INGESTION", uploaded_at="2026-09-02T10:00:00Z")]
    )
    monkeypatch.setattr(kb, "_agent", lambda: agent)
    monkeypatch.setattr(kb, "_table", lambda: table)

    result = kb.handler(EVENT, None)

    assert agent.started == 1
    assert table.rows[0]["files"][0]["status"] == "PENDING_INGESTION"
    # Re-driven so a later invocation can flip the row once the job it just started has finished.
    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}]}


def test_fails_a_document_a_completed_job_did_not_index(monkeypatch: pytest.MonkeyPatch) -> None:
    # A job ran AFTER the upload and the document is still absent. This is the silent-drop case:
    # the job would have reported numberOfDocumentsFailed: 0, and the only evidence is that
    # ListKnowledgeBaseDocuments does not contain the key.
    agent = _FakeAgent(
        jobs=[{"status": "COMPLETE", "startedAt": dt.datetime(2026, 9, 2, 11, tzinfo=dt.UTC)}],
        documents=[],
    )
    table = _FakeTable(
        rows=[_row(keys=[KEY], status="PENDING_INGESTION", uploaded_at="2026-09-02T10:00:00Z")]
    )
    monkeypatch.setattr(kb, "_agent", lambda: agent)
    monkeypatch.setattr(kb, "_table", lambda: table)

    result = kb.handler(EVENT, None)

    file_row = table.rows[0]["files"][0]
    assert file_row["status"] == "FAILED"
    assert "did not index" in file_row["error"]
    # Settled either way, so the message is not re-driven -- retrying forever would hide it.
    assert agent.started == 0
    assert result == {"batchItemFailures": []}


def test_refuses_to_run_without_its_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KB_ID")
    with pytest.raises(RuntimeError, match="KB_ID"):
        kb.handler(EVENT, None)
