"""Tests for the general-ledger Athena tool Lambda (query builder + handler)."""

import pytest

from backend.gl_tool.handler import build_query, handle


def test_build_query_filters_and_escaping():
    q = build_query(
        reference="Paydown_and_Interest_Notice.pdf",
        borrower="CASCADE'S HOLDINGS",  # quote must be escaped, not break out
        min_amount=100.5,
        max_amount=2000000,
        limit=10,
    )
    assert "reference = 'Paydown_and_Interest_Notice.pdf'" in q
    assert "CASCADE''S HOLDINGS" in q  # single quote doubled
    assert "amount >= 100.5" in q and "amount <= 2000000" in q
    assert q.strip().endswith("LIMIT 10")


def test_build_query_no_filters_is_bounded():
    q = build_query()
    assert "WHERE" not in q
    assert "LIMIT 25" in q  # default cap — never an unbounded scan


def test_build_query_rejects_bad_amounts():
    with pytest.raises(ValueError):
        build_query(min_amount="1; DROP TABLE")  # non-numeric must fail loudly


class _FakeAthena:
    """Stubbed Athena client: start -> succeeded -> canned rows."""

    def __init__(self, rows):
        self._rows = rows
        self.query = None

    def start_query_execution(self, **kw):
        self.query = kw["QueryString"]
        return {"QueryExecutionId": "qid-1"}

    def get_query_execution(self, **kw):
        return {"QueryExecution": {"Status": {"State": "SUCCEEDED"}}}

    def get_query_results(self, **kw):
        header = [{"VarCharValue": c} for c in ["entry_id", "reference", "amount"]]
        data = [
            {"Data": [{"VarCharValue": v} for v in row]} for row in self._rows
        ]
        return {"ResultSet": {"Rows": [{"Data": header}] + data}}


def test_handle_returns_rows_as_dicts(monkeypatch):
    monkeypatch.setenv("GL_DATABASE", "recon_gl")
    monkeypatch.setenv("GL_TABLE", "gl_entries")
    monkeypatch.setenv("ATHENA_WORKGROUP", "recon-gl")
    fake = _FakeAthena(rows=[["GL-1", "Doc.pdf", "2052425.70"]])
    out = handle(
        {"reference": "Doc.pdf"}, None, athena=fake, sleeper=lambda s: None
    )
    assert out["rows"] == [
        {"entry_id": "GL-1", "reference": "Doc.pdf", "amount": "2052425.70"}
    ]
    assert out["count"] == 1
    assert "reference = 'Doc.pdf'" in fake.query
