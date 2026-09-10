"""Harness worker invoke loop: execute→worker gateway write→RESOLVED+lesson,
escalate→PROPOSED, failure→degraded, double-delivery no-op, write-denied→PROPOSED. Uses an
injected invoke transport (harness stream) + injected write_transport (gateway write) + moto."""

import boto3
from moto import mock_aws

from backend.harness_agent import worker
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import EvidenceStep, ReconItem

# The skill's `evidence_steps` are the denominator of the proposal's confidence — the number the
# threshold in `_run` compares against — so the loop tests cannot exercise the execute path without
# them. `_submit_events` reports both as satisfied, and `_ledger_events` provides the tool call that
# keeps those claims from being downgraded.
CATALOG = [{"name": "document-cross-reference", "confidence_threshold": 0.7,
            "evidence_steps": [EvidenceStep(id="ledger_hit", description="the ledger entry"),
                               EvidenceStep(id="notice_hit", description="the notice")]},
           {"name": "unknown", "confidence_threshold": 0.0}]
ITEM = ReconItem(item_id="idp-1", domain="loan-servicing",
                 sides=[{"name": "ledger", "attributes": {"reference": "DDTL-A-0001"}}],
                 attributes={"idp_class": "LoanDrawCancellationNotice"})


def _tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(TableName="recon-cases",
                     KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
                     AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
                     BillingMode="PAY_PER_REQUEST")
    ddb.create_table(TableName="recon-audit",
                     KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"},
                                {"AttributeName": "ts", "KeyType": "RANGE"}],
                     AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"},
                                           {"AttributeName": "ts", "AttributeType": "S"}],
                     BillingMode="PAY_PER_REQUEST")
    ddb.Table("recon-cases").put_item(Item={"item_id": "idp-1", "status": "IN_PROGRESS"})
    return ddb


# --- stream event builders -------------------------------------------------------------------

def _ledger_events():
    return [
        {"contentBlockStart": {"contentBlockIndex": 0,
                               "start": {"toolUse": {"toolUseId": "t1", "name": "general-ledger___search_ledger"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"reference":"DDTL-A-0001"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"toolResult": {"toolUseId": "t1", "name": "general-ledger___search_ledger",
                        "content": [{"json": {"rows": [{"reference": "DDTL-A-0001"}]}}], "status": "success"}},
    ]


def _submit_events(status="Cancelled", satisfied=("ledger_hit", "notice_hit")):
    """Build a submit_proposal stream. `satisfied` selects which prescribed steps are reported as
    obtained, which is what sets the proposal's confidence: both => 1.0, one => 0.5."""
    reports = ",".join(
        '{"step_id":"%s","satisfied":%s}' % (sid, "true" if sid in satisfied else "false")
        for sid in ("ledger_hit", "notice_hit")
    )
    body = ('{"class_name":"document-cross-reference","classification_reasoning":"x",'
            f'"resolution":"Mark cancelled","status":"{status}","reason":"pushed",'
            '"evidence":["reference: DDTL-A-0001"],'
            f'"evidence_steps":[{reports}]}}')
    return [
        {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "t2", "name": "submit_proposal"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": body}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


def _write_events():
    """Second-turn stream: the closing summary turn (the model no longer performs writes)."""
    return [
        {"messageStop": {"stopReason": "end_turn"}},
    ]


def _run(invoke, threshold=0.9, write_transport=None, write_calls=None):
    """Drive run_investigation with a stubbed gateway write (records calls into write_calls)."""
    cases = CaseStore(table="recon-cases", audit="recon-audit")

    def _default_write(tool_name, arguments):
        if write_calls is not None:
            write_calls.append((tool_name, arguments))
        return {"content": []}

    return worker.run_investigation(
        item=ITEM, invoke=invoke, cases=cases, catalog=CATALOG, threshold=threshold,
        write_transport=write_transport or _default_write,
        # Required keyword (no default) — the worker labels the run's token usage with it. See
        # tests/harness_agent/test_worker_token_usage.py for what that label has to be in production.
        model_id="us.anthropic.claude-sonnet-5",
    ), cases


@mock_aws
def test_execute_path_resolves_and_writes_lesson(monkeypatch):
    ddb = _tables()
    monkeypatch.setenv("LESSONS_TABLE", "recon-lessons")
    ddb.create_table(TableName="recon-lessons",
                     KeySchema=[{"AttributeName": "lesson_id", "KeyType": "HASH"}],
                     AttributeDefinitions=[{"AttributeName": "lesson_id", "AttributeType": "S"}],
                     BillingMode="PAY_PER_REQUEST")
    turns = iter([_ledger_events() + _submit_events(), _write_events()])
    outcome, _ = _run(lambda _m: next(turns))
    assert outcome == "executed"
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "RESOLVED"
    assert ddb.Table("recon-lessons").get_item(Key={"lesson_id": "idp-1#AUTO_RESOLVED"}).get("Item")


@mock_aws
def test_escalate_when_below_threshold_stays_proposed():
    _tables()
    # 1 of 2 required evidence steps obtained => 0.5, under the 0.6 threshold.
    turns = iter([_ledger_events() + _submit_events(satisfied=("ledger_hit",)), _write_events()])
    outcome, _ = _run(lambda _m: next(turns), threshold=0.6)
    assert outcome == "escalated"
    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"


@mock_aws
def test_timeout_stop_reason_persists_degraded_proposed():
    _tables()
    outcome, _ = _run(lambda _m: [{"messageStop": {"stopReason": "timeout_exceeded"}}])
    assert outcome == "escalated"
    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"
    assert row["class_id"] == "unknown"


@mock_aws
def test_missing_submit_proposal_persists_degraded():
    _tables()
    outcome, _ = _run(lambda _m: [{"messageStop": {"stopReason": "end_turn"}}])
    assert outcome == "escalated"
    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-1"})["Item"]
    assert row["class_id"] == "unknown"


@mock_aws
def test_write_denied_by_policy_stays_proposed():
    _tables()
    # execute decision, but the worker's gateway write is denied (Cedar/interceptor) → escalate.
    turns = iter([_ledger_events() + _submit_events(), [{"messageStop": {"stopReason": "end_turn"}}]])

    def _denied(tool_name, arguments):
        raise RuntimeError("gateway tools/call failed: AccessDenied by policy")

    outcome, _ = _run(lambda _m: next(turns), threshold=0.9, write_transport=_denied)
    assert outcome == "escalated"
    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"


@mock_aws
def test_double_delivery_second_run_is_noop():
    """A second delivery (case already PROPOSED, not IN_PROGRESS) does not re-resolve."""
    ddb = _tables()
    turns = iter([_ledger_events() + _submit_events(), _write_events()])
    _run(lambda _m: next(turns))  # first delivery → RESOLVED
    # Second delivery: case is RESOLVED; the APPROVED transition guard blocks re-resolution.
    turns2 = iter([_ledger_events() + _submit_events(), _write_events()])
    outcome, _ = _run(lambda _m: next(turns2))
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "RESOLVED"  # unchanged; no illegal transition


@mock_aws
def test_stale_builtin_tool_does_not_shadow_submit_proposal():
    """Regression: the harness's built-in `skills` toolUse (already resolved, higher
    contentBlockIndex in an earlier turn) must not shadow the final submit_proposal —
    indices reset per turn, so pending = most recently STARTED unresolved toolUse."""
    _tables()
    skills_turn = [
        {"contentBlockStart": {"contentBlockIndex": 3,
                               "start": {"toolUse": {"toolUseId": "sk1", "name": "skills"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 3, "delta": {"toolUse": {"input": '{"skill_name":"x"}'}}}},
        {"contentBlockStop": {"contentBlockIndex": 3}},
        {"toolResult": {"toolUseId": "sk1", "name": "skills", "content": [{"json": {"ok": True}}], "status": "success"}},
    ]
    turns = iter([skills_turn + _ledger_events() + _submit_events(), _write_events()])
    calls = []
    outcome, _ = _run(lambda _m: next(turns), write_calls=calls)
    assert outcome == "executed"  # submit_proposal was recognized; worker executed the write
    assert calls and calls[0][0] == "set-draw-status___set_draw_status"


def _submit_events_malformed():
    """A submit_proposal missing BOTH `resolution` and `reason` (unrecoverable) — but with a valid
    class_name. build_proposal must reject it, yet the degraded persist should PRESERVE the
    classification rather than collapse to unknown."""
    body = ('{"class_name":"document-cross-reference","classification_reasoning":"x",'
            '"evidence":["reference: DDTL-A-0001"]}')
    return [
        {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "t2", "name": "submit_proposal"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": body}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


@mock_aws
def test_malformed_proposal_preserves_the_classification():
    """Regression: a submit_proposal missing `resolution` must not collapse the case to unknown and
    discard a correct classification. The degraded persist keeps the model's class — it names the
    skill whose prescribed steps a re-run would be scored against, so throwing it away costs the
    human reviewer the one piece of the proposal that was sound."""
    ddb = _tables()
    outcome, _ = _run(lambda _m: _ledger_events() + _submit_events_malformed())
    assert outcome == "escalated"
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"
    assert row["class_id"] == "document-cross-reference"      # preserved, NOT "unknown"
    assert "malformed proposal" in row["resolution"]          # still flagged for the human


def test_toolresult_message_uses_text_not_json_content():
    """Regression: the closing re-invoke's toolResult MUST carry a `text` (JSON-string) part,
    never a bare `json` content block. The managed harness ("loopy") wraps a Strands Agent whose
    Bedrock provider raises `TypeError: content_type=<json_> | unsupported type` on a `json` part,
    which failed EVERY closing re-invoke. See backend/harness_agent/worker.py:_toolresult_message."""
    import json

    decision = {"decision": "execute", "reference": "DDTL-A-0001",
                "confidence": 0.9812, "threshold": 0.95, "outcome": "executed"}
    msg = worker._toolresult_message("t-close", decision)
    parts = msg["content"][0]["toolResult"]["content"]
    assert [p for p in parts if "json" in p] == []  # no bare json part → Strands can format it
    assert json.loads(parts[0]["text"]) == decision  # text round-trips the decision losslessly
