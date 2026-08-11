"""Analyst-agreement evaluator: latest decision wins (corrected→0, approved/auto-resolved→1),
sanitized item-id matching (session ids can't carry dots), no lesson→abstain,
unparseable session id→abstain."""

import boto3
from moto import mock_aws

from backend.eval_agreement.handler import handle, score_session

LESSONS_TABLE = "recon-dev-lessons"


def _make_table():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=LESSONS_TABLE,
        KeySchema=[{"AttributeName": "lesson_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "lesson_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return ddb


def _put_lesson(ddb, item_id: str, trigger: str, created_at: str):
    ddb.Table(LESSONS_TABLE).put_item(
        Item={
            "lesson_id": f"{item_id}#{trigger}",
            "item_id": item_id,
            "trigger": trigger,
            "created_at": created_at,
        }
    )


@mock_aws
def test_corrected_scores_zero():
    ddb = _make_table()
    _put_lesson(ddb, "idp-Notice.pdf", "USER_CORRECTION", "2026-07-27T10:00:00Z")
    result = score_session(
        session_id="recon-idp-Notice.pdf-0-abcdef0123456789abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 0.0
    assert result["label"] == "DISAGREED"


@mock_aws
def test_approved_scores_one():
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "USER_APPROVED", "2026-07-27T10:00:00Z")
    result = score_session(
        session_id="recon-idp-1-0-abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 1.0
    assert result["label"] == "AGREED"


@mock_aws
def test_auto_resolved_scores_one():
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "AUTO_RESOLVED", "2026-07-27T10:00:00Z")
    result = score_session(
        session_id="recon-idp-1-1-abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 1.0


@mock_aws
def test_no_lesson_abstains():
    ddb = _make_table()
    result = score_session(
        session_id="recon-idp-new-0-abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result is None


def test_unparseable_session_id_abstains():
    result = score_session(
        session_id="not-a-recon-session", lessons_table=LESSONS_TABLE
    )
    assert result is None


@mock_aws
def test_sanitized_item_id_matches_dotted_lesson_key():
    """Session ids can't contain dots, so they carry 'idp-Notice-pdf' while the lesson is
    keyed by the raw 'idp-Notice.pdf' — matching must happen on the sanitized form. This
    was the live bug: every UI-driven session abstained forever."""
    ddb = _make_table()
    _put_lesson(ddb, "idp-Notice.pdf", "USER_APPROVED", "2026-07-27T10:00:00Z")
    result = score_session(
        session_id="recon-idp-Notice-pdf-4-abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 1.0
    assert result["label"] == "AGREED"


@mock_aws
def test_handle_abstains_with_label_only_response(monkeypatch):
    """Abstain must be a valid success response: label present, NO value (the old
    {"abstain": true} sentinel was rejected by the service as InvalidLambdaResponse)."""
    monkeypatch.setenv("LESSONS_TABLE", LESSONS_TABLE)
    _make_table()
    out = handle({"session_id": "recon-idp-new-0-abcdef0123456789"})
    assert out["label"] == "ABSTAIN"
    assert "value" not in out
    assert "explanation" in out


@mock_aws
def test_handle_extracts_session_id_from_span_attributes(monkeypatch):
    """The evaluation service sends raw OTel spans (camelCase sessionSpans); the session id
    lives in span attributes under 'session.id', not as a top-level field."""
    monkeypatch.setenv("LESSONS_TABLE", LESSONS_TABLE)
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "USER_APPROVED", "2026-07-27T10:00:00Z")
    # Real service envelope (SDK decorator): spans nested under evaluationInput.
    event = {
        "evaluationInput": {
            "sessionSpans": [
                {"name": "GET", "attributes": {"http.method": "GET"}},
                {
                    "name": "invoke_agent Strands Agents",
                    "attributes": {"session.id": "recon-idp-1-0-abcdef0123456789"},
                },
            ],
        },
        "evaluationLevel": "SESSION",
        "evaluationTarget": {"traceIds": ["abc"]},
    }
    out = handle(event)
    assert out["value"] == 1.0
    assert out["label"] == "AGREED"


@mock_aws
def test_handle_extracts_session_id_from_otlp_kv_attributes(monkeypatch):
    """Batch evaluations pass spans with OTLP list-of-kv attributes
    ([{key, value:{stringValue}}]) instead of the flat dict the online path uses —
    the live batch backfill abstained with an empty session id until this shape
    was handled."""
    monkeypatch.setenv("LESSONS_TABLE", LESSONS_TABLE)
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "USER_APPROVED", "2026-07-27T10:00:00Z")
    event = {
        "evaluationInput": {
            "sessionSpans": [
                {
                    "name": "invoke_agent Strands Agents",
                    "attributes": [
                        {"key": "gen_ai.operation.name", "value": {"stringValue": "invoke_agent"}},
                        {"key": "session.id", "value": {"stringValue": "recon-idp-1-0-abcdef0123456789"}},
                    ],
                },
            ],
        },
        "evaluationLevel": "SESSION",
    }
    out = handle(event)
    assert out["value"] == 1.0
    assert out["label"] == "AGREED"


@mock_aws
def test_latest_decision_wins_approval_after_correction():
    """An approval issued AFTER a correction supersedes it (latest decision wins) — the old
    'correction always wins' rule let a stale correction permanently outvote a re-approval."""
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "USER_CORRECTION", "2026-07-27T10:00:00Z")
    _put_lesson(ddb, "idp-1", "USER_APPROVED", "2026-07-28T12:00:00Z")
    result = score_session(
        session_id="recon-idp-1-0-abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 1.0
    assert result["label"] == "AGREED"


@mock_aws
def test_latest_decision_wins_correction_after_approval():
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "USER_APPROVED", "2026-07-27T10:00:00Z")
    _put_lesson(ddb, "idp-1", "USER_CORRECTION", "2026-07-28T12:00:00Z")
    result = score_session(
        session_id="recon-idp-1-0-abcdef0123456789",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 0.0
    assert result["label"] == "DISAGREED"


@mock_aws
def test_reprocess_attempt_parses_correctly():
    """A session from a re-investigate attempt (attempt > 0) still parses the item_id."""
    ddb = _make_table()
    _put_lesson(ddb, "idp-1", "AUTO_RESOLVED", "2026-07-27T10:00:00Z")
    result = score_session(
        session_id="recon-idp-1-3-aabbccdd01234567",
        lessons_table=LESSONS_TABLE, ddb=ddb,
    )
    assert result["value"] == 1.0
