"""set_draw_status write tool: idempotent, allowlisted status writes to the GL status overlay.

Authorization (Cedar confidence/principal gates) and provenance live at the GATEWAY
(Policy + REQUEST interceptor — see tests/gateway_interceptor/ and the live suite in
tests/integration/); this Lambda keeps only value validation + the idempotent write.
"""

import boto3
import pytest
from moto import mock_aws

from backend.gl_tool.write_handler import ALLOWED_STATUSES, handle

TABLE = "recon-dev-gl-status"


def _make_tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=TABLE,
        KeySchema=[{"AttributeName": "reference", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "reference", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb


def _env(monkeypatch):
    monkeypatch.setenv("GL_STATUS_TABLE", TABLE)


@mock_aws
def test_write_persists_status_record(monkeypatch):
    _env(monkeypatch)
    _make_tables()
    out = handle(
        {"reference": "DDTL-A-0001", "status": "Cancelled", "reason": "DRAW DATE PUSHED",
         "item_id": "idp-Notice.pdf"},
        None,
        now="2026-07-23T12:00:00Z",
    )
    assert out["reference"] == "DDTL-A-0001"
    assert out["status"] == "Cancelled"
    row = boto3.resource("dynamodb", region_name="us-east-1").Table(TABLE).get_item(
        Key={"reference": "DDTL-A-0001"}
    )["Item"]
    assert row["status"] == "Cancelled"
    assert row["reason"] == "DRAW DATE PUSHED"
    assert row["item_id"] == "idp-Notice.pdf"
    assert row["updated_at"] == "2026-07-23T12:00:00Z"


@mock_aws
def test_write_is_idempotent(monkeypatch):
    _env(monkeypatch)
    _make_tables()
    handle({"reference": "R1", "status": "Cancelled", "reason": "a", "item_id": "i-1"},
           None, now="t1")
    handle({"reference": "R1", "status": "Confirmed", "reason": "b", "item_id": "i-1"},
           None, now="t2")
    tbl = boto3.resource("dynamodb", region_name="us-east-1").Table(TABLE)
    assert tbl.scan()["Count"] == 1  # single row, updated in place
    assert tbl.get_item(Key={"reference": "R1"})["Item"]["status"] == "Confirmed"


@mock_aws
def test_write_rejects_out_of_allowlist_status(monkeypatch):
    _env(monkeypatch)
    _make_tables()
    with pytest.raises(ValueError, match="status"):
        handle({"reference": "R1", "status": "Deleted", "reason": "x"}, None, now="t")
    # Nothing written on rejection.
    assert boto3.resource("dynamodb", region_name="us-east-1").Table(TABLE).scan()["Count"] == 0
    assert "Cancelled" in ALLOWED_STATUSES


@mock_aws
def test_write_rejects_blank_reference(monkeypatch):
    _env(monkeypatch)
    _make_tables()
    with pytest.raises(ValueError, match="reference"):
        handle({"reference": "", "status": "Cancelled", "reason": "x"}, None, now="t")
