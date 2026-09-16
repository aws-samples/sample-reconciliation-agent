"""A harness throttle is a FAILED case, not a zero-confidence proposal.

Under a burst this is the difference between a queue an analyst can act on and thousands of
`confidence=0.0` PROPOSED rows that look exactly like genuine low-confidence escalations.
"""

import time

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from backend.harness_agent import worker
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem

CATALOG = [{"name": "unknown", "confidence_threshold": 0.0}]
ITEM = ReconItem(item_id="idp-1", domain="loan-servicing", sides=[{"name": "ledger"}])


def _tables():
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName="recon-audit",
        KeySchema=[
            {"AttributeName": "item_id", "KeyType": "HASH"},
            {"AttributeName": "ts", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "ts", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table("recon-cases").put_item(Item={"item_id": "idp-1", "status": "IN_PROGRESS"})
    return ddb


def _run(invoke):
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    return worker.run_investigation(
        item=ITEM,
        invoke=invoke,
        cases=cases,
        catalog=CATALOG,
        threshold=0.9,
        write_transport=lambda _t, _a: {"content": []},
        model_id="us.anthropic.claude-sonnet-5",
        deadline=time.monotonic() + 900.0,
    )


def _throttle():
    return ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "Too many requests"}}, "InvokeHarness"
    )


@mock_aws
def test_a_throttle_lands_FAILED_not_a_degraded_proposal():
    ddb = _tables()

    def _boom(_m):
        raise _throttle()

    assert _run(_boom) == "failed"
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "FAILED"
    assert "throttled" in row["failure_reason"]
    # The tell that distinguishes the two outcomes: no proposal was invented.
    assert "class_id" not in row


@mock_aws
def test_a_non_throttle_transport_error_still_degrades_as_before():
    """Work happened, so the degraded row carries what there was. No regression here."""
    ddb = _tables()

    def _boom(_m):
        raise RuntimeError("connection reset")

    assert _run(_boom) == "failed"
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"
    assert row["class_id"] == "unknown"


@mock_aws
def test_the_known_content_type_parse_bug_is_NOT_a_throttle():
    """This repo already raises EventStreamError for an unrelated botocore/JSON-block mismatch.

    Matching on exception TYPE would silently reclassify that known bug as a capacity problem and
    change its case outcome from degraded-PROPOSED to FAILED.
    """
    ddb = _tables()

    class _EventStreamError(Exception):
        pass

    def _boom(_m):
        raise _EventStreamError("Unknown content_type=<json_> in event stream")

    assert _run(_boom) == "failed"
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"


@pytest.mark.parametrize(
    "code",
    [
        "ThrottlingException",
        "ThrottledException",
        "TooManyRequestsException",
        "ServiceQuotaExceededException",
    ],
)
def test_every_quota_code_is_recognised(code):
    exc = ClientError({"Error": {"Code": code, "Message": "x"}}, "InvokeHarness")
    assert worker._is_throttle(exc) is True


def test_a_mid_stream_throttle_is_recognised_by_message():
    """A throttle arriving inside the event stream has no `response`, only text."""

    class _EventStreamError(Exception):
        pass

    assert worker._is_throttle(_EventStreamError("ThrottlingException: slow down")) is True


def test_an_ordinary_error_is_not_a_throttle():
    assert worker._is_throttle(RuntimeError("connection reset")) is False


def test_run_investigation_requires_a_deadline():
    """Two sequential blocking calls: one read_timeout for both would permit ~2x the budget."""
    with pytest.raises(TypeError, match="deadline"):
        worker.run_investigation(
            item=ITEM,
            invoke=lambda _m: [],
            cases=None,
            catalog=CATALOG,
            threshold=0.9,
            model_id="us.anthropic.claude-sonnet-5",
        )
