"""``UpdateItem`` helpers: reserved-word aliasing, list creation on first append, guarded writes."""

import re

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from backend.recon_core.ddb_update import (
    is_conditional_check_failed,
    update_attributes,
    utc_now_iso,
)
from tests.fakes.ddb import make_table


def test_utc_now_iso_is_second_precision_with_a_z_suffix():
    # The format the deal pipeline persists; the BFF parses it with Date.parse and sorts on it.
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", utc_now_iso())


@mock_aws
def test_set_aliases_reserved_words_and_stores_none_as_null():
    table = make_table("deals", "deal_id")
    table.put_item(Item={"deal_id": "d-1", "status": "STAGED", "error": "old"})
    update_attributes(
        table, {"deal_id": "d-1"}, {"status": "APPROVED", "error": None, "upload": {"ok": 1}}
    )
    item = table.get_item(Key={"deal_id": "d-1"})["Item"]
    assert item == {"deal_id": "d-1", "status": "APPROVED", "error": None, "upload": {"ok": 1}}


@mock_aws
def test_append_creates_the_list_when_missing_and_extends_it_when_present():
    table = make_table("deals", "deal_id")
    table.put_item(Item={"deal_id": "d-1"})
    update_attributes(
        table, {"deal_id": "d-1"}, {"status": "A"}, append={"history": [{"action": "A"}]}
    )
    update_attributes(
        table, {"deal_id": "d-1"}, {"status": "B"}, append={"history": [{"action": "B"}]}
    )
    item = table.get_item(Key={"deal_id": "d-1"})["Item"]
    assert item["status"] == "B"
    assert item["history"] == [{"action": "A"}, {"action": "B"}]


@mock_aws
def test_expect_mismatch_raises_the_conditional_check_failure_and_writes_nothing():
    table = make_table("deals", "deal_id")
    table.put_item(Item={"deal_id": "d-1", "status": "REJECTED", "history": []})
    with pytest.raises(ClientError) as info:
        update_attributes(
            table,
            {"deal_id": "d-1"},
            {"status": "UPLOADED"},
            append={"history": [{"action": "UPLOAD_ACCEPTED"}]},
            expect={"status": "APPROVED"},
        )
    assert is_conditional_check_failed(info.value)
    assert table.get_item(Key={"deal_id": "d-1"})["Item"] == {
        "deal_id": "d-1",
        "status": "REJECTED",
        "history": [],
    }


@mock_aws
def test_expect_match_lets_the_write_through():
    table = make_table("deals", "deal_id")
    table.put_item(Item={"deal_id": "d-1", "status": "APPROVED"})
    update_attributes(
        table, {"deal_id": "d-1"}, {"status": "UPLOADED"}, expect={"status": "APPROVED"}
    )
    assert table.get_item(Key={"deal_id": "d-1"})["Item"]["status"] == "UPLOADED"


def test_is_conditional_check_failed_only_for_that_code():
    failed = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
    other = ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem")
    assert is_conditional_check_failed(failed) is True
    assert is_conditional_check_failed(other) is False
    assert is_conditional_check_failed(RuntimeError("not botocore")) is False
