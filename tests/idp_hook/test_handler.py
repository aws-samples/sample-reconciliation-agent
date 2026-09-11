"""Tests for the IDP post-processing hook Lambda handler.

The behavioural centre of Phase 1 is here: an extracted document must produce a NOTICE and must not
produce a reconciliation item: an extracted document is evidence ABOUT an item, never the thing that
creates one.

Phase 2 (this file, post-Task-4) widens that: EVERY terminal IDP outcome -- SUCCEEDED, FAILED,
TIMED_OUT, ABORTED, and a SUCCEEDED execution recon cannot map to a notice -- must leave SOME row in
recon-notices, so the Documents tab (which no longer reads IDP's own AppSync API) never shows a
document as if it never existed.
"""

import json
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.idp_hook.handler import handle
from backend.recon_core.notice_derive import PARSE_METHOD_IDP
from tests.recon_core.test_notices import _make_notices_table


@pytest.fixture(autouse=True)
def _notices_table_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the hook at the moto notices table.

    The handler reads ``os.environ["NOTICES_TABLE"]`` with no default: a misconfigured hook must
    fail its invocation and land in the DLQ, not write to a name that happens to be right in dev.

    :param monkeypatch: pytest's environment patcher.
    :returns: None.
    """
    monkeypatch.setenv("NOTICES_TABLE", "recon-notices")
    monkeypatch.setenv("NOTICE_SEARCH_TABLE", "recon-notice-search")


def _make_items_table():
    """Create the recon-items table so an accidental item write would SUCCEED rather than error.

    A missing table would make the "no items were written" assertion pass for the wrong reason.

    :returns: the boto3 Table resource for recon-items.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    return ddb.create_table(
        TableName="recon-items",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


# Realistic EventBridge epoch-millisecond timestamps (see tracking.py) -- included by default so
# every event built here carries a resolvable `initial_event_time`, which
# `NoticeStore.put_document_record` requires to derive its GSI key. A test that needs to exercise
# the "no resolvable start time" edge case should pass `start_date=None` explicitly.
_START_DATE_MS = 1788967194871
_STOP_DATE_MS = 1788967254871


def _event(
    doc,
    *,
    status="SUCCEEDED",
    execution_arn="arn:aws:states:::execution:idp:run-1",
    start_date=_START_DATE_MS,
    stop_date=_STOP_DATE_MS,
):
    """Wrap a document in the IDP completion event shape.

    IDP delivers detail.output as a JSON-ENCODED STRING containing {"document": {...}}, with the
    per-run id at detail.executionArn and epoch-millisecond timestamps at startDate/stopDate.

    :param doc: the IDP document record.
    :param status: the Step Functions execution status to stamp on the event.
    :param execution_arn: the Step-Function run id to stamp on the event.
    :param start_date: epoch-millisecond execution start time, or None to omit it.
    :param stop_date: epoch-millisecond execution stop time, or None to omit it.
    :returns: the EventBridge event dict.
    """
    detail = {
        "status": status,
        "executionArn": execution_arn,
        "output": json.dumps({"document": doc}),
    }
    if start_date is not None:
        detail["startDate"] = start_date
    if stop_date is not None:
        detail["stopDate"] = stop_date
    return {"detail": detail}


# Includes a FLOAT confidence — proves the end-to-end DynamoDB put survives (would crash without
# the mapper's float→Decimal conversion).
DOC = {
    "id": "doc-1",
    "input_key": "n/1.pdf",
    "output_bucket": "idp-out",
    "sections": [
        {
            "section_id": "s0",
            "classification": "Notice",
            "extraction_result_uri": "s3://idp-out/n/1.pdf/sections/s0/result.json",
            "attributes": {
                "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
                "notice_date": "2026-03-02",
                "amount": "10.00",
            },
            "confidence_threshold_alerts": [
                {"attribute_name": "total_amount", "confidence": 0.93, "confidence_threshold": 0.8}
            ],
        }
    ],
}

# A well-formed document used with `_force_mapping_failure` below. It maps cleanly on its own; the
# tests that use it are about the HANDLER's behaviour when mapping fails, not about which validation
# the mapper happens to enforce, so the failure is injected rather than provoked by malformed input.
DOC_UNMAPPABLE = {
    "id": "doc-2",
    "input_key": "n/2.pdf",
    "output_bucket": "idp-out",
    "sections": [
        {
            "section_id": "s0",
            "classification": "Notice",
            "attributes": {
                "counterparty": "UNMAPPABLE COUNTERPARTY INC.",
                "notice_date": "2026-03-02",
            },
        }
    ],
}

# Same document, plus the pipeline's own `errors` field -- used to prove that field wins over the
# mapper's ValueError text.
DOC_UNMAPPABLE_WITH_ERRORS = {
    **DOC_UNMAPPABLE,
    "id": "doc-3",
    "errors": "IDP Assessment step raised InternalServiceException",
}

MAPPING_ERROR = "synthetic mapping failure: this document is not a record"


def _force_mapping_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make `idp_event_to_notice` raise, so the handler's failure branch is what is under test.

    Injected rather than provoked with malformed input. Every concrete trigger couples the test to one
    of the mapper's validation rules, so the test breaks whenever that rule legitimately changes even
    though the branch it covers has not -- and a malformed document can fail somewhere EARLIER than the
    mapper (`tracking.build_tracking_snapshot` raises AttributeError on a bare-string section), which
    exercises a different path while still going red.

    :param monkeypatch: pytest's attribute patcher.
    :returns: None.
    """

    def _raise(*_args, **_kwargs):
        raise ValueError(MAPPING_ERROR)

    monkeypatch.setattr("backend.idp_hook.handler.idp_event_to_notice", _raise)


# A document whose section carries no OutputJSONUri/Sections at all -- output_bucket/input_key
# (the snake_case fallback _derive_output_location reads) point the mapper at a REAL seeded IDP
# output object instead, so the classification_confidence/confidence_alert_count derivation runs
# through IdpOutputReader end to end rather than degrading to the event-only fallback path (which
# never populates either field -- see test_extraction_confidence_and_alert_count_derivation_is_unchanged
# below for why that distinction matters).
CONFIDENCE_BUCKET = "idp-out"
CONFIDENCE_PREFIX = "n/confidence.pdf"
DOC_WITH_REAL_CONFIDENCE = {
    "id": "doc-confidence",
    "input_key": CONFIDENCE_PREFIX,
    "output_bucket": CONFIDENCE_BUCKET,
    "sections": [
        {
            "section_id": "s0",
            "classification": "Notice",
            "attributes": {
                "counterparty": "REAL CONFIDENCE COUNTERPARTY INC.",
                "notice_date": "2026-03-02",
                "amount": "10.00",
            },
        }
    ],
}


def _seed_real_confidence_output() -> None:
    """Seed IDP output S3 with a real section result carrying ``explainability_info``.

    Mirrors ``test_assessment_confidence.py``'s ``_seed_explainability`` (see that module for why
    a PER-FIELD threshold, never a global one, is the only correct comparison): one extracted
    field (``amount``, confidence 0.70) scores below its own 0.8 threshold, the other
    (``counterparty``, confidence 0.95) does not -- so the derived numbers are unambiguous:
    ``confidence_alert_count == 1`` and ``extraction_confidence == mean(0.95, 0.70) == 0.825``.

    :returns: None.
    """
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=CONFIDENCE_BUCKET)
    s3.put_object(
        Bucket=CONFIDENCE_BUCKET,
        Key=f"{CONFIDENCE_PREFIX}/sections/1/result.json",
        Body=json.dumps(
            {
                "document_class": {"type": "Notice"},
                "split_document": {"page_indices": [0]},
                "inference_result": {
                    "counterparty": "REAL CONFIDENCE COUNTERPARTY INC.",
                    "notice_date": "2026-03-02",
                    "amount": "10.00",
                },
                "explainability_info": [
                    {
                        "counterparty": {"confidence": 0.95, "confidence_threshold": 0.8},
                        "amount": {"confidence": 0.70, "confidence_threshold": 0.8},
                    }
                ],
            }
        ).encode(),
    )


@mock_aws
def test_succeeded_event_writes_one_notice_and_no_items() -> None:
    """Extraction produces evidence, not a case."""
    _make_notices_table()
    items = _make_items_table()

    result = handle(_event(DOC), None)

    assert result["written"] == 1 and result["notice_id"] == "idp-doc-1"
    assert items.scan()["Count"] == 0


@mock_aws
def test_the_stored_notice_carries_the_extraction_and_the_run_id() -> None:
    """The notice is the audit record of the extraction, so provenance has to survive the write."""
    _make_notices_table()
    handle(_event(DOC, execution_arn="run-A"), None)

    from backend.recon_core.notices import NoticeStore

    notice = NoticeStore(table_name="recon-notices").get(notice_id="idp-doc-1")
    assert notice.notice_class == "Notice"
    assert notice.counterparty == "CINDERMOOR LOGISTICS HOLDINGS INC."
    assert notice.idp_execution_arn == "run-A"


@mock_aws
def test_succeeded_notice_carries_idp_tracking_and_gsi_attrs() -> None:
    """The Documents tab reads pipeline progress off the notice row, not off AppSync any more.

    Both the embedded snapshot and the two promoted GSI key attributes (idp_record/idp_started_at,
    derived from it by _idp_gsi_attrs -- see notices.py) must land on the stored item.
    """
    _make_notices_table()
    handle(_event(DOC), None)

    from backend.recon_core.notices import NoticeStore

    raw = NoticeStore(table_name="recon-notices").raw(notice_id="idp-doc-1")
    assert raw["idp_tracking"]["workflow_status"] == "SUCCEEDED"
    assert raw["idp_record"] == "document"
    assert "idp_started_at" in raw


@mock_aws
def test_extraction_confidence_and_alert_count_derivation_is_unchanged() -> None:
    """REGRESSION GUARD: the gateway interceptor refuses a ledger write it cannot evaluate, keyed
    off exactly these two fields, so Task 4 must not touch how they are derived -- only whether
    idp_tracking/page_count are attached alongside them.

    Deliberately does NOT use the DOC fixture: DOC's section carries no OutputJSONUri/Sections, so
    the mapper's IdpOutputReader read fails (no bucket seeded) and silently degrades to the
    event-only fallback path in ``_read_sections`` -- which never sets
    ``classification_confidence``/``confidence_alert_count`` on the fallback-parsed section at
    all. Asserting ``None`` against THAT fixture would pass under almost any bug that always
    nulls these two fields (a short-circuited section loop, a forgotten `alert_total` wire-up):
    it looks like a guard and isn't one. Seeding a REAL IDP output object (mirroring
    ``test_assessment_confidence.py`` and this file's own
    ``test_a_compressed_event_is_resolved_before_mapping``) makes both values come back as real,
    non-``None`` Decimals, so a regression that nulls or corrupts the derivation actually fails
    this test.
    """
    _make_notices_table()
    _seed_real_confidence_output()

    handle(_event(DOC_WITH_REAL_CONFIDENCE), None)

    from backend.recon_core.notices import NoticeStore

    notice = NoticeStore(table_name="recon-notices").get(notice_id="idp-doc-confidence")
    # One extracted field (amount, 0.70) scores below its OWN 0.8 threshold; counterparty (0.95)
    # does not -- see _seed_real_confidence_output's docstring for the arithmetic.
    assert notice.confidence_alert_count == 1
    assert notice.extraction_confidence == Decimal("0.825")


@mock_aws
def test_redelivered_event_is_an_idempotent_overwrite() -> None:
    """notice_id is deterministic and the put is unconditional, so re-delivery cannot duplicate."""
    table = _make_notices_table()
    event = _event(DOC)

    handle(event, None)
    handle(event, None)

    # One row, no "duplicate" disposition to report, and no case to re-drive.
    assert table.scan()["Count"] == 1


@mock_aws
def test_a_new_idp_run_overwrites_without_redriving_anything() -> None:
    """A genuine reprocess replaces the stale extraction. There is no case, so nothing re-drives."""
    table = _make_notices_table()

    handle(_event(DOC, execution_arn="run-A"), None)
    result = handle(_event(DOC, execution_arn="run-B"), None)

    assert result["written"] == 1 and result["notice_id"] == "idp-doc-1"
    assert table.scan()["Count"] == 1
    rows = table.scan()["Items"]
    assert rows[0]["idp_execution_arn"] == "run-B"


@mock_aws
def test_a_compressed_event_is_resolved_before_mapping() -> None:
    """The shape every real recon-dev extraction actually delivers.

    Step Functions caps an execution's output at 256 KB, so IDP writes the tracking record to its
    working bucket and the event carries only a pointer plus a stand-in whose ``sections`` is a list
    of id STRINGS. The hook must fetch the real record before mapping: handing the stand-in to the
    mapper raises ``AttributeError: 'str' object has no attribute 'get'`` for EVERY succeeded
    execution in the deployed IDP stack, so nothing reaches the notices table at all — a failure mode
    a live re-drive found in Task 41 and no unit test did.

    Asserted through ``handle`` rather than against ``resolve_document`` directly because what matters
    is the CALL, not the resolution: a resolver that passes its own tests and is never invoked leaves
    the hook exactly as broken.

    :returns: None.
    """
    _make_notices_table()
    items = _make_items_table()
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="idp-working")
    s3.put_object(
        Bucket="idp-working",
        Key="compressed_documents/doc-1/1787840761573_evaluation_state.json",
        Body=json.dumps(DOC).encode(),
    )
    stand_in = {
        "document_id": "doc-1",
        "s3_uri": "s3://idp-working/compressed_documents/doc-1/1787840761573_evaluation_state.json",
        "num_pages": 6,
        "status": "EVALUATING",
        "sections": ["1", "2"],
        "compressed": True,
    }

    result = handle(_event(stand_in), None)

    # The resolved record's own id wins, so the notice is the same row a non-compressed delivery of
    # the same document would have written — re-delivery in either shape must not fork the notice.
    assert result["written"] == 1 and result["notice_id"] == "idp-doc-1"
    assert items.scan()["Count"] == 0


@mock_aws
def test_a_compressed_event_with_an_unreadable_pointer_fails_loudly() -> None:
    """A fieldless notice is worse than a DLQ'd invocation, so the read must not degrade.

    The enrichment read inside the mapper degrades gracefully on purpose (a transient IDP-S3 blip
    should not drop the document). Resolution is different in kind: without the record there are no
    sections, no output bucket and no fields, so "degrading" would store a notice that is indexed,
    citable and empty. Pinned so nobody harmonises the two by wrapping this in the same try/except.

    :returns: None.
    """
    _make_notices_table()
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="idp-working")  # bucket exists, object does not

    event = _event(
        {
            "document_id": "doc-1",
            "s3_uri": "s3://idp-working/compressed_documents/doc-1/gone.json",
            "sections": ["1"],
            "compressed": True,
        }
    )
    with pytest.raises(Exception, match="NoSuchKey"):
        handle(event, None)


@mock_aws
def test_non_terminal_status_writes_nothing() -> None:
    """A RUNNING execution is not a terminal outcome of any kind -- there is nothing to record yet,
    and no tracking row should appear only to be superseded moments later."""
    table = _make_notices_table()
    result = handle(_event(DOC, status="RUNNING"), None)
    assert result == {"written": 0, "notice_id": None}
    assert table.scan()["Count"] == 0


@mock_aws
def test_failed_event_writes_a_tracking_row_and_no_notice() -> None:
    """A FAILED execution produced no extraction, so it must not become a Notice -- but it must not
    vanish either: the Documents tab has to be able to show that this document failed."""
    table = _make_notices_table()
    items = _make_items_table()

    result = handle(_event(DOC, status="FAILED"), None)

    assert result == {"written": 1, "notice_id": None, "kind": "document"}
    assert items.scan()["Count"] == 0

    rows = table.scan()["Items"]
    assert len(rows) == 1
    row = rows[0]
    assert row["notice_id"] == "idp-doc-1"
    assert row["record_kind"] == "document"
    assert row["source_document"] == "doc-1"
    assert row["parse_method"] == PARSE_METHOD_IDP
    assert "idp_tracking" in row
    assert "notice_failure_reason" in row


@pytest.mark.parametrize("status", ["FAILED", "TIMED_OUT", "ABORTED"])
@mock_aws
def test_every_terminal_non_succeeded_status_writes_a_tracking_row(status: str) -> None:
    """All three terminal non-SUCCEEDED statuses take the same tracking-only path."""
    table = _make_notices_table()
    result = handle(_event(DOC, status=status), None)
    assert result == {"written": 1, "notice_id": None, "kind": "document"}
    assert table.scan()["Items"][0]["record_kind"] == "document"


@mock_aws
def test_an_unmappable_document_writes_a_tracking_row_then_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ONE bend in this module's fail-loudly convention: the tracking row is written FIRST so
    the document is visible to an operator, and THEN the ValueError is re-raised so EventBridge's
    retry/DLQ still engages -- the row must never be written and the error swallowed."""
    _force_mapping_failure(monkeypatch)
    table = _make_notices_table()
    items = _make_items_table()

    with pytest.raises(ValueError, match="synthetic mapping failure"):
        handle(_event(DOC_UNMAPPABLE), None)

    assert items.scan()["Count"] == 0
    rows = table.scan()["Items"]
    assert len(rows) == 1
    row = rows[0]
    assert row["notice_id"] == "idp-doc-2"
    assert row["record_kind"] == "document"
    assert MAPPING_ERROR in row["notice_failure_reason"]


@mock_aws
def test_a_dateless_document_is_stored_as_a_notice_not_dead_lettered() -> None:
    """A dateless document becomes a real notice, not a tracking-only failure row.

    A fax cover carrying a counterparty and an agent bank is worth keeping. `notice_date` is ABSENT on
    it -- not blank, and not back-filled from the pipeline's start time -- because `search_notices`
    reports absence as `fields_unavailable` while any stored value reads as a date the extractor
    resolved.
    """
    table = _make_notices_table()
    doc = {
        **DOC_UNMAPPABLE,
        "id": "doc-4",
        "sections": [
            {
                "section_id": "s0",
                "classification": "Notice",
                "attributes": {"counterparty": "PARTIAL FAX COVER LLP", "agent_bank": "Meridian"},
            }
        ],
    }

    result = handle(_event(doc), None)

    assert result["written"] == 1 and result["notice_id"] == "idp-doc-4"
    row = next(r for r in table.scan()["Items"] if r["notice_id"] == "idp-doc-4")
    assert row["record_kind"] == "notice"
    assert "notice_date" not in row, "a dateless notice must store the field as ABSENT"
    assert "notice_failure_reason" not in row


@mock_aws
def test_notice_failure_reason_prefers_the_records_own_errors_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A genuine pipeline failure describes itself better than recon's mapping step can, so the
    resolved record's own `errors` field must win over the mapper's ValueError text when both
    exist."""
    _force_mapping_failure(monkeypatch)
    _make_notices_table()

    with pytest.raises(ValueError):
        handle(_event(DOC_UNMAPPABLE_WITH_ERRORS), None)

    from backend.recon_core.notices import NoticeStore

    row = NoticeStore(table_name="recon-notices").raw(notice_id="idp-doc-3")
    assert row["notice_failure_reason"] == "IDP Assessment step raised InternalServiceException"


@mock_aws
def test_failed_then_succeeded_for_the_same_document_leaves_exactly_one_row() -> None:
    """Duplicate-row guard, end to end through the handler: a document that FAILS and is later
    reprocessed successfully must overwrite its own tracking row, not sit beside a second one."""
    table = _make_notices_table()

    handle(_event(DOC, status="FAILED"), None)
    result = handle(_event(DOC, status="SUCCEEDED"), None)

    assert result["written"] == 1 and result["notice_id"] == "idp-doc-1"
    rows = table.scan()["Items"]
    assert len(rows) == 1
    row = rows[0]
    assert row["record_kind"] == "notice"
    assert "notice_failure_reason" not in row
