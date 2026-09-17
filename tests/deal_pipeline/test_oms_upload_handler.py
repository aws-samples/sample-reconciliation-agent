"""Mock OMS upload Lambda end to end against mocked DynamoDB and S3."""

import pytest

from backend.deal_pipeline.oms_schema import to_csv
from backend.deal_pipeline.oms_upload_handler import handle
from backend.deal_pipeline.oms_validator import VALIDATOR_VERSION
from tests.deal_pipeline.conftest import clean_loan_fields


def seed_deal(aws, deal_id: str, fields: dict, csv_text: str | None = None) -> None:
    aws.deals.put_item(
        Item={
            "deal_id": deal_id,
            "email_id": "em_copperfield",
            "opportunity_name": fields["opportunity_name"],
            "status": "APPROVED",
            "fields": fields,
            "original_fields": fields,
            "evidence": {},
            "assumptions": [],
            "memory_hits": [],
            "skills_used": [],
            "enrichment": {"issuer_match": None, "fields_from_security_master": []},
            "csv_key": f"deal-csv/{deal_id}.csv",
            "upload": None,
            "history": [{"at": "2026-08-05T14:00:00Z", "actor": "parser", "action": "STAGED"}],
            "created_at": "2026-08-05T14:00:00Z",
            "updated_at": "2026-08-05T14:00:00Z",
        }
    )
    body = csv_text if csv_text is not None else to_csv(fields)
    aws.s3.put_object(Bucket=aws.bucket, Key=f"deal-csv/{deal_id}.csv", Body=body.encode("utf-8"))


def test_accepted_upload_copies_to_oms_staging(aws):
    fields = clean_loan_fields()
    seed_deal(aws, "dl_ok", fields)

    result = handle({"deal_id": "dl_ok"}, None)

    assert result["accepted"] is True and result["errors"] == []
    assert result["staging_key"] == "oms-staging/dl_ok.csv"
    assert result["validator_version"] == VALIDATOR_VERSION
    assert result["deal_id"] == "dl_ok" and result["status"] == "UPLOADED"
    staged = (
        aws.s3.get_object(Bucket=aws.bucket, Key="oms-staging/dl_ok.csv")["Body"].read().decode()
    )
    assert staged == to_csv(fields)

    deal = aws.deals.get_item(Key={"deal_id": "dl_ok"})["Item"]
    assert deal["status"] == "UPLOADED"
    assert (
        deal["upload"]["accepted"] is True
        and deal["upload"]["attempted_at"] == result["attempted_at"]
    )
    assert [h["action"] for h in deal["history"]] == ["STAGED", "UPLOAD_ACCEPTED"]
    assert deal["history"][-1]["actor"] == "mock-oms"
    assert deal["updated_at"] == result["attempted_at"]


def test_rejected_upload_records_the_error_codes(aws):
    fields = clean_loan_fields()
    fields["covenant_status_num"] = ""
    fields["left_agent"] = "Silverline Partners"
    seed_deal(aws, "dl_bad", fields)

    result = handle({"deal_id": "dl_bad"}, None)

    assert result["accepted"] is False and result["staging_key"] is None
    assert sorted(e["code"] for e in result["errors"]) == [
        "COVENANT_STATUS_REQUIRED",
        "LEFT_AGENT_UNKNOWN",
    ]
    left_agent = next(e for e in result["errors"] if e["code"] == "LEFT_AGENT_UNKNOWN")
    assert "'Silverline'" in left_agent["hint"]
    assert result["status"] == "UPLOAD_FAILED"
    with pytest.raises(aws.s3.exceptions.NoSuchKey):
        aws.s3.get_object(Bucket=aws.bucket, Key="oms-staging/dl_bad.csv")

    deal = aws.deals.get_item(Key={"deal_id": "dl_bad"})["Item"]
    assert deal["status"] == "UPLOAD_FAILED"
    assert deal["upload"]["errors"][0]["code"] in {"COVENANT_STATUS_REQUIRED", "LEFT_AGENT_UNKNOWN"}
    assert deal["history"][-1]["action"] == "UPLOAD_REJECTED"
    assert deal["history"][-1]["detail"] == "Rejected: COVENANT_STATUS_REQUIRED, LEFT_AGENT_UNKNOWN"


def test_unreadable_csv_is_a_header_mismatch(aws):
    seed_deal(aws, "dl_broken", clean_loan_fields(), csv_text="Pipeline Status\n")
    result = handle({"deal_id": "dl_broken"}, None)
    assert [e["code"] for e in result["errors"]] == ["HEADER_MISMATCH"]
    assert result["errors"][0]["field"] is None
    assert "could not be read" in result["errors"][0]["message"]


def test_header_from_a_hand_edited_file_is_reported_alongside_value_errors(aws):
    fields = clean_loan_fields()
    csv_text = to_csv(fields).replace("Pipeline Status,", "Status,", 1)
    seed_deal(aws, "dl_header", fields, csv_text=csv_text)
    result = handle({"deal_id": "dl_header"}, None)
    codes = sorted(e["code"] for e in result["errors"])
    # The renamed column's value is no longer mapped, so the required field reads as blank too.
    assert codes == ["HEADER_MISMATCH", "REQUIRED_MISSING"]


def test_upload_needs_only_the_counterparties_object(aws):
    # The OMS role can read one key; issuers.csv being absent (or unreadable) must not matter.
    aws.s3.delete_object(Bucket=aws.bucket, Key="security-master/issuers.csv")
    seed_deal(aws, "dl_ok", clean_loan_fields())
    result = handle({"deal_id": "dl_ok"}, None)
    assert result["accepted"] is True and result["status"] == "UPLOADED"


def test_upload_reads_the_counterparties_key_from_the_environment(aws, monkeypatch):
    # Terraform passes COUNTERPARTIES_KEY; a renamed prefix must move the read with it.
    body = aws.s3.get_object(Bucket=aws.bucket, Key="security-master/counterparties.csv")["Body"]
    aws.s3.put_object(Bucket=aws.bucket, Key="reference/cp.csv", Body=body.read())
    aws.s3.delete_object(Bucket=aws.bucket, Key="security-master/counterparties.csv")
    seed_deal(aws, "dl_ok", clean_loan_fields())

    monkeypatch.setenv("COUNTERPARTIES_KEY", "reference/cp.csv")
    assert handle({"deal_id": "dl_ok"}, None)["accepted"] is True

    # Pointed at nothing, the canonical list is empty and every left agent is unknown -- a
    # rejected upload with a stable code, never a crash.
    monkeypatch.setenv("COUNTERPARTIES_KEY", "reference/missing.csv")
    seed_deal(aws, "dl_nolist", clean_loan_fields())
    result = handle({"deal_id": "dl_nolist"}, None)
    assert [e["code"] for e in result["errors"]] == ["LEFT_AGENT_UNKNOWN"]


def test_unknown_deal_raises(aws):
    with pytest.raises(KeyError):
        handle({"deal_id": "dl_missing"}, None)


def test_verdict_is_not_persisted_when_the_deal_is_no_longer_approved(aws):
    """A reviewer's reject that lands mid-upload wins: no status flip, no staging copy."""
    fields = clean_loan_fields()
    seed_deal(aws, "dl_withdrawn", fields)
    aws.deals.update_item(
        Key={"deal_id": "dl_withdrawn"},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "REJECTED"},
    )

    result = handle({"deal_id": "dl_withdrawn"}, None)

    assert result["accepted"] is True and result["persisted"] is False
    assert result["status"] == "REJECTED"
    deal = aws.deals.get_item(Key={"deal_id": "dl_withdrawn"})["Item"]
    assert deal["status"] == "REJECTED" and deal["upload"] is None
    assert len(deal["history"]) == 1
    keys = [o["Key"] for o in aws.s3.list_objects_v2(Bucket=aws.bucket).get("Contents", [])]
    assert "oms-staging/dl_withdrawn.csv" not in keys
