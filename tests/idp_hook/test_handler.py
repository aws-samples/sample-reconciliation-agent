"""Tests for the IDP post-processing hook Lambda handler.

The behavioural centre of Phase 1 is here: an extracted document must produce a NOTICE and must not
produce a reconciliation item: an extracted document is evidence ABOUT an item, never the thing that
creates one.
"""

import json

import boto3
import pytest
from moto import mock_aws

from backend.idp_hook.handler import handle
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


def _event(doc, *, execution_arn="arn:aws:states:::execution:idp:run-1"):
    """Wrap a document in the IDP completion event shape.

    IDP delivers detail.output as a JSON-ENCODED STRING containing {"document": {...}}, with the
    per-run id at detail.executionArn.

    :param doc: the IDP document record.
    :param execution_arn: the Step-Function run id to stamp on the event.
    :returns: the EventBridge event dict.
    """
    return {
        "detail": {
            "status": "SUCCEEDED",
            "executionArn": execution_arn,
            "output": json.dumps({"document": doc}),
        }
    }


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


@mock_aws
def test_succeeded_event_writes_one_notice_and_no_items() -> None:
    """Extraction produces evidence, not a case."""
    _make_notices_table()
    items = _make_items_table()

    result = handle(_event(DOC), None)

    assert result == {"written": 1, "notice_id": "idp-doc-1"}
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

    assert result == {"written": 1, "notice_id": "idp-doc-1"}
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
    assert result == {"written": 1, "notice_id": "idp-doc-1"}
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
def test_non_succeeded_event_writes_nothing() -> None:
    """A failed extraction is not evidence of anything."""
    _make_notices_table()
    result = handle({"detail": {"status": "FAILED", "output": json.dumps({"document": DOC})}}, None)
    assert result == {"written": 0, "notice_id": None}
