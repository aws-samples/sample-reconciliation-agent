"""search_ledger overlays the status table onto Athena results so reads reflect writes."""

import boto3
from moto import mock_aws

from backend.gl_tool.handler import handle

TABLE = "recon-dev-gl-status"


class _FakeAthena:
    def __init__(self, rows):
        self._rows = rows

    def start_query_execution(self, **kw):
        return {"QueryExecutionId": "qid"}

    def get_query_execution(self, **kw):
        return {"QueryExecution": {"Status": {"State": "SUCCEEDED"}}}

    def get_query_results(self, **kw):
        header = [{"VarCharValue": c} for c in ["entry_id", "reference", "amount"]]
        data = [{"Data": [{"VarCharValue": v} for v in row]} for row in self._rows]
        return {"ResultSet": {"Rows": [{"Data": header}] + data}}


def _make_table_with(ref, status, reason):
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=TABLE,
        KeySchema=[{"AttributeName": "reference", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "reference", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table(TABLE).put_item(
        Item={"reference": ref, "status": status, "reason": reason, "updated_at": "t1"}
    )


@mock_aws
def test_overlay_merges_status_onto_matching_row(monkeypatch):
    monkeypatch.setenv("GL_STATUS_TABLE", TABLE)
    _make_table_with("DDTL-A-0001", "Cancelled", "DRAW DATE PUSHED")
    fake = _FakeAthena(rows=[["GL-1", "DDTL-A-0001", "14000000.00"], ["GL-2", "OTHER-9", "5.0"]])
    out = handle({"reference": "DDTL-A-0001"}, None, athena=fake, sleeper=lambda s: None)
    by_ref = {r["reference"]: r for r in out["rows"]}
    assert by_ref["DDTL-A-0001"]["status"] == "Cancelled"
    assert by_ref["DDTL-A-0001"]["reason"] == "DRAW DATE PUSHED"
    # A row with no overlay entry is untouched (no status key).
    assert "status" not in by_ref["OTHER-9"]


@mock_aws
def test_no_overlay_when_table_unset(monkeypatch):
    monkeypatch.delenv("GL_STATUS_TABLE", raising=False)
    fake = _FakeAthena(rows=[["GL-1", "DDTL-A-0001", "14000000.00"]])
    out = handle({"reference": "DDTL-A-0001"}, None, athena=fake, sleeper=lambda s: None)
    assert out["rows"][0] == {"entry_id": "GL-1", "reference": "DDTL-A-0001", "amount": "14000000.00"}
