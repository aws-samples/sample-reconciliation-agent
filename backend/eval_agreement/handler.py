"""Analyst-agreement custom evaluator for AgentCore Online/Batch Evaluations.

Measures whether the human who reviewed the case in the console ACCEPTED what the agent
proposed. This is deliberately not "scoring against ground truth": there is no labelled answer
key anywhere: the lessons ledger is the RECORD of a reviewer's decision, written when they
acted on the case. Among all decision lessons for the item, the one with the LATEST
``created_at`` wins (an approval issued after a correction supersedes it — mirroring that the
eval always reviews the latest session spans):
  - latest is USER_CORRECTION → 0.0 (a reviewer changed the proposal, so it was not accepted)
  - latest is USER_APPROVED → 1.0 (a reviewer accepted it as proposed)
  - latest is AUTO_RESOLVED → 1.0. ⚠️ No human looked at this one: the agent's confidence
    cleared the auto-resolve threshold and Policy permitted the write. It scores as agreement
    because nobody objected, which is weaker evidence than an approval and is why the two
    labels stay distinct in the ledger even though they score the same here.
  - no decision lesson → abstain (nobody has reviewed the case yet)

Session ids cannot contain dots (AgentCore constraint), so they carry a SANITIZED item id
(``idp-Notice-pdf``) while lessons are keyed by the raw id (``idp-Notice.pdf``). The
sanitization is irreversible, so matching happens on the sanitized side: the table is scanned
and each lesson's ``item_id`` is sanitized before comparison (the lessons ledger is
demo-scale; a keyed lookup cannot express this).

The evaluator is registered as a SESSION-level custom code-based evaluator. It parses the
sanitized item id out of the session id — shape ``recon-<sanitized item_id>-<sha256 fragment>``,
truncated to 64 characters; see `backend/harness_agent/session.py` for the full contract and the
truncation caveat — and returns `{value, label, explanation}` or a label-only ABSTAIN.
"""

import json
import logging
import os
import re
from typing import Any

import boto3

from backend.harness_agent.session import item_id_from_session

logger = logging.getLogger(__name__)

# Lesson triggers that constitute a ground-truth decision.
_POSITIVE = {"USER_APPROVED", "AUTO_RESOLVED"}
_NEGATIVE = {"USER_CORRECTION"}
_DECISION_TRIGGERS = _POSITIVE | _NEGATIVE

# Must match the session-id sanitization in BOTH builders — backend/tier1/invoke_agent.py
# (the normal path) and the BFF's retry/reprocess actions (cases/[id]/route.ts). AgentCore
# session ids only allow [a-zA-Z0-9-_], so every other character becomes '-'.
_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9_-]")


def _sanitize(item_id: str) -> str:
    """Sanitize an item id the same way session ids are built from it.

    :param item_id: raw case item id (may contain dots etc.).
    :returns: the id with every character outside [a-zA-Z0-9_-] replaced by '-'.
    """
    return _SANITIZE_RE.sub("-", item_id)


def _decision_lessons(table, sanitized_item_id: str) -> list[dict[str, Any]]:
    """Collect all decision lessons whose (sanitized) item id matches.

    :param table: boto3 DynamoDB Table resource for the lessons ledger.
    :param sanitized_item_id: the item id as parsed from the session id (sanitized form).
    :returns: matching lesson dicts (trigger in the decision set).
    """
    matches: list[dict[str, Any]] = []
    scan_kwargs: dict[str, Any] = {}
    while True:
        resp = table.scan(**scan_kwargs)
        for lesson in resp.get("Items", []):
            raw_item = lesson.get("item_id") or str(lesson.get("lesson_id", "")).split("#")[0]
            trigger = lesson.get("trigger") or str(lesson.get("lesson_id", "")).split("#")[-1]
            if trigger in _DECISION_TRIGGERS and _sanitize(raw_item) == sanitized_item_id:
                matches.append({**lesson, "trigger": trigger})
        if "LastEvaluatedKey" not in resp:
            return matches
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def score_session(*, session_id: str, lessons_table: str, ddb=None) -> dict[str, Any] | None:
    """Score one agent session against the lessons ledger (latest decision wins).

    :param session_id: the AgentCore runtime session id (``recon-<sanitized item_id>-<sha256
        fragment>``, truncated to 64 characters).
    :param lessons_table: DynamoDB lessons table name.
    :param ddb: injectable DynamoDB resource (tests); real resource by default.
    :returns: ``{value: 0|1, label, explanation}`` or ``None`` to abstain (no lesson yet).
    """
    item_id = item_id_from_session(session_id)
    if not item_id:
        logger.warning("session_id %s does not match recon pattern; abstaining", session_id)
        return None

    ddb = ddb or boto3.resource("dynamodb")
    table = ddb.Table(lessons_table)

    lessons = _decision_lessons(table, _sanitize(item_id))
    if not lessons:
        # No decision yet — abstain (the decision hook / batch eval re-scores later).
        return None

    # Latest decision wins: ISO-8601 created_at sorts lexicographically; lessons missing a
    # timestamp sort first (oldest) so any dated decision beats them.
    latest = max(lessons, key=lambda lesson: str(lesson.get("created_at", "")))
    trigger = latest["trigger"]
    when = latest.get("created_at", "unknown time")
    if trigger in _NEGATIVE:
        return {
            "value": 0.0,
            "label": "DISAGREED",
            "explanation": f"Latest analyst decision for {item_id}: corrected ({trigger} at {when})",
        }
    return {
        "value": 1.0,
        "label": "AGREED",
        "explanation": f"Latest analyst decision for {item_id}: agreed ({trigger} at {when})",
    }


def _attr(attrs, key: str) -> str:
    """Read one attribute from OTel attributes in either wire shape.

    Spans arrive either with a flat dict (``{"session.id": "..."}``, the CloudWatch JSON
    shape) or with the raw OTLP list-of-kv shape
    (``[{"key": "session.id", "value": {"stringValue": "..."}}]``) depending on the
    invocation path (online vs batch evaluation).

    :param attrs: the span's ``attributes`` value (dict, list, or None).
    :param key: attribute key to read.
    :returns: the string value, or ``""`` when absent.
    """
    if isinstance(attrs, dict):
        value = attrs.get(key)
        return value if isinstance(value, str) else ""
    if isinstance(attrs, list):
        for kv in attrs:
            if isinstance(kv, dict) and kv.get("key") == key:
                value = kv.get("value")
                if isinstance(value, dict):
                    return str(value.get("stringValue") or value.get("string_value") or "")
                return str(value or "")
    return ""


def _session_id_from_spans(spans: list) -> str:
    """Extract the AgentCore session id from raw OTel session spans.

    The session id lives in each span's ``attributes`` under ``session.id`` (injected by
    the runtime); some payload shapes also carry it as a top-level span field.

    :param spans: raw span dicts from the evaluation event.
    :returns: the first non-empty session id found, or ``""`` when absent.
    """
    for span in spans:
        if not isinstance(span, dict):
            continue
        sid = (
            _attr(span.get("attributes"), "session.id")
            or span.get("sessionId")
            or span.get("session_id")
            or ""
        )
        if sid:
            return str(sid)
    # Diagnosability: the payload shape has changed twice already (dict vs OTLP kv-list);
    # log a truncated sample so the next drift is visible in CloudWatch instead of silent.
    if spans:
        try:
            sample = json.dumps(spans[0])[:800]
        except (TypeError, ValueError):
            sample = str(spans[0])[:800]
        logger.warning("no session.id found in %d spans; first span: %s", len(spans), sample)
    return ""


def handle(event, _context=None):
    """Lambda handler invoked by the AgentCore evaluation service (code-based evaluator).

    Raw event carries ``{sessionSpans, evaluationLevel, targetTraceId}`` (camelCase; older
    shapes used snake_case — both accepted). For direct invocation (testing), pass
    ``{session_id: str}``.

    Response contract (docs: code-based-evaluators, Response schema): success responses
    REQUIRE ``label`` (``value``/``explanation`` optional); anything else — including the
    old ``{"abstain": true}`` sentinel — is rejected by the service as InvalidLambdaResponse.
    Abstaining is therefore expressed as a label-only response with NO ``value``, so no
    numeric datapoint reaches the EvaluationScore metric.
    """
    session_id = event.get("session_id") or ""
    if not session_id:
        # Real service envelope (per the bedrock_agentcore SDK decorator):
        # event["evaluationInput"]["sessionSpans"]. Top-level keys kept as fallbacks.
        evaluation_input = event.get("evaluationInput") or {}
        spans = (
            evaluation_input.get("sessionSpans")
            or event.get("sessionSpans")
            or event.get("session_spans")
            or []
        )
        session_id = _session_id_from_spans(spans)

    lessons_table = os.environ.get("LESSONS_TABLE", "")
    if not lessons_table:
        raise ValueError("LESSONS_TABLE env not configured")

    result = score_session(session_id=session_id, lessons_table=lessons_table)
    if result is None:
        return {
            "label": "ABSTAIN",
            "explanation": (
                f"No analyst decision recorded yet for session {session_id or '<unknown>'} "
                "— re-score via batch evaluation once the case is approved or corrected."
            ),
        }
    return result
