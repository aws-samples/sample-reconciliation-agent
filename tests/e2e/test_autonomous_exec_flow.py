"""End-to-end autonomous-execution flow (moto-backed, real write handler + overlay).

Wires the confidence gate (autonomous_execute) to the REAL set_draw_status write handler and
proves the two paths:
  - composite >= threshold + clean action  -> write executes -> gl status overlay reflects it
  - composite <  threshold                 -> no write -> overlay untouched (escalate)
Then the human-approve deferred path executes the same write for an escalated case.
"""

import boto3
from moto import mock_aws

from backend.recon_core.auto_resolve import autonomous_execute

from backend.gl_tool.handler import handle as gl_read
from backend.gl_tool.write_handler import handle as gl_write
from backend.recon_core.schema import Proposal

STATUS_TABLE = "recon-dev-gl-status"
CASES_TABLE = "recon-dev-cases"
THRESHOLD_PARAM = "/recon-dev/auto-resolve-threshold"
ACTION = {"tool": "set_draw_status", "reference": "DDTL-A-0001", "status": "Cancelled", "reason": "pushed", "item_id": "idp-1"}


class _FakeAthena:
    """Athena stub returning one ledger row for reference DDTL-A-0001."""

    def start_query_execution(self, **kw):
        return {"QueryExecutionId": "qid"}

    def get_query_execution(self, **kw):
        return {"QueryExecution": {"Status": {"State": "SUCCEEDED"}}}

    def get_query_results(self, **kw):
        header = [{"VarCharValue": c} for c in ["entry_id", "reference", "amount"]]
        row = [{"VarCharValue": v} for v in ["GL-1", "DDTL-A-0001", "14000000.00"]]
        return {"ResultSet": {"Rows": [{"Data": header}, {"Data": row}]}}


def _make_status_table():
    boto3.resource("dynamodb", region_name="us-east-1").create_table(
        TableName=STATUS_TABLE,
        KeySchema=[{"AttributeName": "reference", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "reference", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _setup_gates(monkeypatch, *, threshold: str):
    """Wire the set_draw_status server-side gates: cases table (provenance) + SSM threshold.

    Seeds the PROPOSED case carrying the same proposed_action.reference the agent will write, so
    the autonomous (gateway) path passes provenance + threshold — mirroring production.
    """
    monkeypatch.setenv("CASES_TABLE", CASES_TABLE)
    monkeypatch.setenv("AUTO_RESOLVE_PARAM", THRESHOLD_PARAM)
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CASES_TABLE,
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table(CASES_TABLE).put_item(
        Item={"item_id": "idp-1", "status": "PROPOSED",
              "proposed_action": {k: v for k, v in ACTION.items() if k != "tool"}}
    )
    boto3.client("ssm", region_name="us-east-1").put_parameter(
        Name=THRESHOLD_PARAM, Value=threshold, Type="String", Overwrite=True
    )


def _invoker(action):
    """Production-shaped invoker: call the real write handler (as the deployed Lambda would).

    The agent path carries `confidence` (injected by autonomous_execute) and NO human_approved,
    so the write handler enforces provenance + threshold — exactly the gateway invocation."""
    return gl_write(action, None, now="2026-07-23T00:00:00Z")


def _proposal(confidence, action):
    return Proposal(
        item_id="idp-1", class_id="document-cross-reference",
        classification_reasoning="draw cancellation", resolution="Mark cancelled.",
        confidence=confidence, proposed_action=action,
    )


@mock_aws
def test_high_confidence_executes_and_overlay_reflects_it(monkeypatch):
    monkeypatch.setenv("GL_STATUS_TABLE", STATUS_TABLE)
    _make_status_table()
    _setup_gates(monkeypatch, threshold="0.95")

    prop = _proposal(0.97, ACTION)
    outcome = autonomous_execute(proposal=prop, threshold=0.95, invoker=_invoker)
    assert outcome == "executed"

    # The ledger read now reflects the executed status change via the overlay.
    rows = gl_read({"reference": "DDTL-A-0001"}, None, athena=_FakeAthena(), sleeper=lambda s: None)["rows"]
    assert rows[0]["status"] == "Cancelled"
    assert rows[0]["reason"] == "pushed"


@mock_aws
def test_low_confidence_leaves_overlay_untouched(monkeypatch):
    monkeypatch.setenv("GL_STATUS_TABLE", STATUS_TABLE)
    _make_status_table()

    prop = _proposal(0.80, ACTION)
    outcome = autonomous_execute(proposal=prop, threshold=0.95, invoker=_invoker)
    assert outcome == "escalated"

    # No write happened — the read carries no overlaid status.
    rows = gl_read({"reference": "DDTL-A-0001"}, None, athena=_FakeAthena(), sleeper=lambda s: None)["rows"]
    assert "status" not in rows[0]


@mock_aws
def test_escalated_then_human_approve_executes_the_write(monkeypatch):
    """Low-confidence escalates unactioned; a later human approval performs the same write."""
    monkeypatch.setenv("GL_STATUS_TABLE", STATUS_TABLE)
    _make_status_table()
    _setup_gates(monkeypatch, threshold="0.95")

    prop = _proposal(0.80, ACTION)
    assert autonomous_execute(proposal=prop, threshold=0.95, invoker=_invoker) == "escalated"

    # Human approves: the BFF executes the PERSISTED action through the gateway (Cedar's
    # principal-scoped human permit authorizes it — no confidence argument). Provenance still
    # applies and passes trivially because the BFF writes exactly the persisted reference.
    human_call = {k: v for k, v in prop.proposed_action.items() if k != "tool"}
    gl_write(human_call, None, now="2026-07-23T01:00:00Z")
    rows = gl_read({"reference": "DDTL-A-0001"}, None, athena=_FakeAthena(), sleeper=lambda s: None)["rows"]
    assert rows[0]["status"] == "Cancelled"
