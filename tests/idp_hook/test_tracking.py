"""Tests for :func:`backend.idp_hook.tracking.build_tracking_snapshot`.

The fixtures mirror the two accepted IDP tracking-record shapes documented in
``backend/idp_hook/tracking.py`` and ``backend/idp_hook/mapper.py``: the live snake_case record
(verified against a real run) and the older PascalCase record the existing mapper fixtures use.
Both must produce the same snapshot from equivalent data -- that equivalence is the point of the
module having exactly one implementation.
"""

from decimal import Decimal

from backend.idp_hook.tracking import build_tracking_snapshot

# The live event's detail carries epoch-MILLISECOND timestamps (verified against a real run), not
# seconds and not ISO strings. 1788967194871 ms -> 2026-09-09T15:19:54.871000+00:00 (UTC).
_START_DATE_MS = 1788967194871
_START_DATE_ISO = "2026-09-09T15:19:54.871000+00:00"
_STOP_DATE_MS = 1788967254871
_STOP_DATE_ISO = "2026-09-09T15:20:54.871000+00:00"


def _detail(**overrides: object) -> dict:
    """Build a minimal EventBridge ``detail`` block.

    :param overrides: keys to replace in the baseline detail.
    :returns: the detail dict.
    """
    detail = {
        "status": "SUCCEEDED",
        "executionArn": "arn:aws:states:::execution:idp:run-1",
        "startDate": _START_DATE_MS,
        "stopDate": _STOP_DATE_MS,
    }
    detail.update(overrides)
    return detail


def _snake_case_document(**overrides: object) -> dict:
    """Build a full live-shape (snake_case) resolved IDP tracking record.

    :param overrides: keys to replace in the baseline record.
    :returns: the record as ``IdpOutputReader.resolve_document`` returns it live.
    """
    doc: dict = {
        "id": "doc-1",
        "status": "EVALUATING",
        "workflow_status": "SUCCEEDED",
        "config_version": "Recon-IDP",
        "evaluation_status": "COMPLETE",
        "queued_time": "2026-08-25T03:43:37.912385+00:00",
        "initial_event_time": "2026-08-25T03:43:36Z",
        "completion_time": "2026-08-25T03:50:00Z",
        "num_pages": 3,
        "evaluation_report_uri": "s3://idp-out/doc-1/evaluation_report.json",
        "summary_report_uri": "s3://idp-out/doc-1/summary_report.json",
        "sections": [
            {
                "section_id": "1",
                "classification": "LoanRateSettingNotice",
                "confidence_threshold_alerts": [
                    {"attribute_name": "amount", "confidence": 0.93, "confidence_threshold": 0.8}
                ],
            },
            {"section_id": "2", "classification": "InterestNotice"},
        ],
    }
    doc.update(overrides)
    return doc


def _pascalcase_document(**overrides: object) -> dict:
    """Build the equivalent older-shape (PascalCase) resolved IDP tracking record.

    Every field carries the same VALUE as :func:`_snake_case_document`'s baseline, under the
    PascalCase key this module also accepts.

    :param overrides: keys to replace in the baseline record.
    :returns: the record in the older PascalCase shape.
    """
    doc: dict = {
        "ObjectKey": "doc-1",
        "ObjectStatus": "EVALUATING",
        "WorkflowStatus": "SUCCEEDED",
        "ConfigVersion": "Recon-IDP",
        "EvaluationStatus": "COMPLETE",
        "QueuedTime": "2026-08-25T03:43:37.912385+00:00",
        "InitialEventTime": "2026-08-25T03:43:36Z",
        "CompletionTime": "2026-08-25T03:50:00Z",
        "PageCount": 3,
        "EvaluationReportUri": "s3://idp-out/doc-1/evaluation_report.json",
        "SummaryReportUri": "s3://idp-out/doc-1/summary_report.json",
        "Sections": [
            {
                "Id": 1,
                "Class": "LoanRateSettingNotice",
                "confidence_threshold_alerts": [
                    {"attribute_name": "amount", "confidence": 0.93, "confidence_threshold": 0.8}
                ],
            },
            {"Id": 2, "Class": "InterestNotice"},
        ],
    }
    doc.update(overrides)
    return doc


def _assert_full_snapshot(snap: dict) -> None:
    """Shared assertions for a fully-populated snapshot, regardless of input casing.

    :param snap: the dict returned by :func:`build_tracking_snapshot`.
    :returns: None.
    """
    assert snap["object_status"] == "EVALUATING"
    assert snap["workflow_status"] == "SUCCEEDED"
    assert snap["config_version"] == "Recon-IDP"
    assert snap["evaluation_status"] == "COMPLETE"
    assert snap["queued_time"] == "2026-08-25T03:43:37.912385+00:00"
    assert snap["initial_event_time"] == "2026-08-25T03:43:36Z"
    assert snap["completion_time"] == "2026-08-25T03:50:00Z"
    assert snap["page_count"] == 3
    assert snap["evaluation_report_uri"] == "s3://idp-out/doc-1/evaluation_report.json"
    assert snap["summary_report_uri"] == "s3://idp-out/doc-1/summary_report.json"
    assert "snapshot_at" in snap
    assert len(snap["sections_meta"]) == 2
    first, second = snap["sections_meta"]
    assert first["section_id"] == "1"
    assert first["confidence_threshold_alerts"] == [
        {
            "attribute_name": "amount",
            "confidence": Decimal("0.93"),
            "confidence_threshold": Decimal("0.8"),
        }
    ]
    assert second["section_id"] == "2"
    assert "confidence_threshold_alerts" not in second


def test_a_full_snakecase_live_shape_record_maps_every_field() -> None:
    """Case 1: the live shape (snake_case) maps every field in the snapshot."""
    snap = build_tracking_snapshot(document=_snake_case_document(), detail=_detail())
    _assert_full_snapshot(snap)


def test_a_pascalcase_record_maps_identically() -> None:
    """Case 2: the older PascalCase shape produces the exact same snapshot, key-for-key."""
    snap = build_tracking_snapshot(document=_pascalcase_document(), detail=_detail())
    _assert_full_snapshot(snap)


def test_workflow_status_falls_back_to_detail_status() -> None:
    """Case 3: when the record omits workflow_status, detail["status"] fills it in."""
    doc = _snake_case_document()
    del doc["workflow_status"]
    snap = build_tracking_snapshot(document=doc, detail=_detail(status="SUCCEEDED"))
    assert snap["workflow_status"] == "SUCCEEDED"


def test_initial_event_time_falls_back_to_epoch_millis_start_date() -> None:
    """Case 4: detail["startDate"] (epoch millis) fallback fires and converts to ISO-8601."""
    doc = _snake_case_document()
    del doc["initial_event_time"]
    snap = build_tracking_snapshot(document=doc, detail=_detail())
    assert snap["initial_event_time"] == _START_DATE_ISO


def test_completion_time_falls_back_to_stop_date_when_record_value_is_none() -> None:
    """Case 5 (THE LIVE CASE): completion_time is present-but-None on the record at hook time --
    the object status is EVALUATING, not yet completed -- so detail["stopDate"] must fill it in.
    """
    doc = _snake_case_document(completion_time=None)
    snap = build_tracking_snapshot(document=doc, detail=_detail())
    assert snap["completion_time"] == _STOP_DATE_ISO


def test_an_absent_optional_field_is_absent_from_the_output() -> None:
    """Case 6: an optional field neither the record nor detail supplies is OMITTED, not blank."""
    doc = _snake_case_document()
    del doc["queued_time"]
    # detail carries no equivalent for queued_time, so there is no fallback that could fill it.
    snap = build_tracking_snapshot(document=doc, detail=_detail())
    assert "queued_time" not in snap


def test_sections_meta_section_id_is_a_string_and_alerts_are_preserved() -> None:
    """Case 7: section_id is a str (joins against idp_sections[].section_id) and alerts survive."""
    doc = _snake_case_document()
    snap = build_tracking_snapshot(document=doc, detail=_detail())
    entry = snap["sections_meta"][0]
    assert isinstance(entry["section_id"], str)
    assert entry["section_id"] == "1"
    assert entry["confidence_threshold_alerts"][0]["attribute_name"] == "amount"

    # Also true for the PascalCase shape, whose Id is numeric on the wire.
    pascal_snap = build_tracking_snapshot(document=_pascalcase_document(), detail=_detail())
    pascal_entry = pascal_snap["sections_meta"][0]
    assert isinstance(pascal_entry["section_id"], str)
    assert pascal_entry["section_id"] == "1"


def test_no_hitl_key_appears_for_any_input_shape() -> None:
    """Case 8: no hitl_* field exists anywhere in this pipeline -- never fabricate one."""
    for doc in (
        _snake_case_document(),
        _pascalcase_document(),
        {"status": "EVALUATING"},  # minimal/degenerate input
    ):
        snap = build_tracking_snapshot(document=doc, detail=_detail())
        assert not any(key.lower().startswith("hitl") for key in snap)
        for section in snap["sections_meta"]:
            assert not any(key.lower().startswith("hitl") for key in section)


def test_page_count_is_a_plain_int_not_a_float_or_decimal() -> None:
    """Numeric page counts must survive as plain ints -- boto3 rejects floats outright."""
    snap = build_tracking_snapshot(document=_snake_case_document(), detail=_detail())
    assert snap["page_count"] == 3
    assert isinstance(snap["page_count"], int)


def test_confidence_alert_floats_become_decimal() -> None:
    """A raw IDP alert float anywhere in sections_meta must be Decimal, or the DynamoDB put
    fails."""
    snap = build_tracking_snapshot(document=_snake_case_document(), detail=_detail())
    alert = snap["sections_meta"][0]["confidence_threshold_alerts"][0]
    assert isinstance(alert["confidence"], Decimal)
    assert isinstance(alert["confidence_threshold"], Decimal)


def test_snapshot_at_is_always_present_even_for_a_minimal_document() -> None:
    """snapshot_at and sections_meta are the only two keys guaranteed regardless of input
    richness."""
    snap = build_tracking_snapshot(document={}, detail=_detail())
    assert "snapshot_at" in snap
    assert snap["sections_meta"] == []
