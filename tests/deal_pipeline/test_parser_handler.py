"""Parser Lambda end to end against mocked DynamoDB, S3 and SSM with a scripted model."""

from types import SimpleNamespace

import pytest

from backend.deal_pipeline import parser_handler
from backend.deal_pipeline.agent import DEFAULT_SYSTEM_PROMPT
from backend.deal_pipeline.oms_schema import to_csv
from backend.deal_pipeline.parser_handler import DEFAULT_MODEL_ID, handle
from tests.deal_pipeline.conftest import MODEL_PARAM
from tests.deal_pipeline.fakes import FakeBedrock, lookup_turn, stage_turn, truncated_turn

SKILL = "---\nname: deal-parsing\ndescription: Parse deal emails.\n---\nTerm loans are Loan; notes are Bond.\n"


def skill_md(name: str, tier: str, applies_to: list[str] | None = None) -> bytes:
    applies = (
        ""
        if applies_to is None
        else ", applies_to: [" + ", ".join(f'"{k}"' for k in applies_to) + "]"
    )
    return f'---\nname: {name}\ndescription: {name}.\nmetadata: {{ tier: "{tier}"{applies} }}\n---\nBody of {name}.\n'.encode()


TIERED_SKILLS = {
    "deal-parsing": skill_md("deal-parsing", "core", ["news-alert", "bank-notice"]),
    "news-alert-format": skill_md("news-alert-format", "format", ["news-alert"]),
    "bank-notice-format": skill_md("bank-notice-format", "format", ["bank-notice"]),
    "oms-csv-format": skill_md("oms-csv-format", "reference", ["news-alert", "bank-notice"]),
}


def lambda_context(remaining_ms: int):
    return SimpleNamespace(get_remaining_time_in_millis=lambda: remaining_ms)


FIELDS = {
    "pipeline_type": "Loan",
    "opportunity_name": "Copperfield refinancing TLB",
    "left_agent": "Silverline Partners",
    "maturity_terms": "7 yr",
    "currency": "USD",
    "issue_size_mm": "$1,295 million",
    "security_type": "Loan",
    "fixed_floating": "Floating",
}


def seed_email(aws, **overrides) -> dict:
    email = {
        "email_id": "em_copperfield",
        "received_at": "2026-08-05T13:58:00Z",
        "source_kind": "bank-notice",
        "from": "New Issues Desk <new-issues@example-firm.test>",
        "to": "Credit Team - Financials <credit-financials@example-firm.test>",
        "subject": "FW: Copperfield Insurance Partners - $1,295MM Term Loan B Refinancing - Launch",
        "sent": "2026-08-05T09:58:00-04:00",
        "body": "Silverline Partners is pleased to announce the launch of the $1,295 million Term Loan B ...",
        "sample_id": "06-bank-notice-copperfield-insurance-tlb",
        "status": "RECEIVED",
        "deal_id": None,
        "parse": None,
        "error": None,
        "updated_at": "2026-08-05T13:58:00Z",
        **overrides,
    }
    aws.emails.put_item(Item=email)
    return email


def seed_assets(aws) -> None:
    aws.s3.put_object(Bucket=aws.bucket, Key="skills/deal-parsing/SKILL.md", Body=SKILL.encode())
    aws.s3.put_object(
        Bucket=aws.bucket, Key="prompts/parser-system.md", Body=b"seeded system prompt"
    )
    aws.ssm.put_parameter(Name=MODEL_PARAM, Value="us.anthropic.claude-sonnet-5", Type="String")


def test_parsed_email_gets_a_deal_and_a_csv(aws):
    seed_email(aws)
    seed_assets(aws)
    bedrock = FakeBedrock([lookup_turn("Copperfield Insurance Partners"), stage_turn(FIELDS)])

    result = handle({"email_id": "em_copperfield"}, None, bedrock=bedrock)

    assert result["status"] == "PARSED" and result["email_id"] == "em_copperfield"
    deal_id = result["deal_id"]
    assert deal_id.startswith("dl_") and len(deal_id.split("_")) == 3

    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["status"] == "PARSED" and email["deal_id"] == deal_id and email["error"] is None
    parse = email["parse"]
    assert parse["fields"]["issue_size_mm"] == "1295.000"
    assert parse["fields"]["left_agent"] == "Silverline Partners"  # the gap the OMS will reject
    assert parse["skills_used"] == ["deal-parsing"] and parse["memory_hits"] == []
    assert parse["enrichment"]["issuer_match"] == "Copperfield Insurance Partners"
    assert parse["model_id"] == "us.anthropic.claude-sonnet-5"

    deal = aws.deals.get_item(Key={"deal_id": deal_id})["Item"]
    assert deal["status"] == "STAGED" and deal["email_id"] == "em_copperfield"
    assert deal["opportunity_name"] == "Copperfield refinancing TLB"
    assert deal["fields"] == deal["original_fields"] == parse["fields"]
    assert deal["csv_key"] == f"deal-csv/{deal_id}.csv" and deal["upload"] is None
    assert [h["action"] for h in deal["history"]] == ["STAGED"]
    assert deal["history"][0]["actor"] == "parser"
    assert "supersedes" not in deal["history"][0]["detail"]  # nothing to retire on a first parse
    assert deal["created_at"] == deal["updated_at"] == email["updated_at"]

    csv_bytes = aws.s3.get_object(Bucket=aws.bucket, Key=deal["csv_key"])["Body"].read()
    assert csv_bytes.decode("utf-8") == to_csv(parse["fields"])

    # The model saw the seeded prompt, the seeded skill and the SSM model id.
    first = bedrock.calls[0]
    assert first["system"] == [{"text": "seeded system prompt"}]
    assert first["modelId"] == "us.anthropic.claude-sonnet-5"
    user_text = first["messages"][0]["content"][0]["text"]
    assert "## Skill: deal-parsing\nTerm loans are Loan; notes are Bond." in user_text
    assert "Subject: FW: Copperfield Insurance Partners" in user_text


def test_email_is_parsing_while_the_model_runs(aws, monkeypatch):
    seed_email(aws)
    seen = {}

    def spy(email, **kwargs):
        seen["status"] = aws.emails.get_item(Key={"email_id": email["email_id"]})["Item"]["status"]
        return parser_handler.parse_email(email, **kwargs)

    monkeypatch.setattr(parser_handler, "parse_email", spy)
    handle({"email_id": "em_copperfield"}, None, bedrock=FakeBedrock([stage_turn(FIELDS)]))
    assert seen["status"] == "PARSING"


def test_defaults_when_prompt_skills_and_model_parameter_are_missing(aws):
    seed_email(aws)
    bedrock = FakeBedrock([stage_turn(FIELDS)])
    result = handle({"email_id": "em_copperfield"}, None, bedrock=bedrock)
    assert result["status"] == "PARSED"
    assert bedrock.calls[0]["modelId"] == DEFAULT_MODEL_ID
    assert bedrock.calls[0]["system"] == [{"text": DEFAULT_SYSTEM_PROMPT}]
    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["parse"]["skills_used"] == []


def test_failure_marks_the_email_parse_failed_and_returns(aws):
    seed_email(aws)
    result = handle(
        {"email_id": "em_copperfield"},
        None,
        bedrock=FakeBedrock([RuntimeError("model unavailable")]),
    )
    assert result == {
        "email_id": "em_copperfield",
        "deal_id": None,
        "status": "PARSE_FAILED",
        "error": "RuntimeError: model unavailable",
    }
    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["status"] == "PARSE_FAILED" and email["error"] == "RuntimeError: model unavailable"
    assert email["deal_id"] is None
    assert aws.deals.scan()["Count"] == 0


def test_unknown_email_raises_before_any_state_change(aws):
    with pytest.raises(KeyError):
        handle({"email_id": "em_missing"}, None, bedrock=FakeBedrock([]))


def test_reparse_of_a_failed_email_clears_the_old_error(aws):
    seed_email(aws, status="PARSE_FAILED", error="RuntimeError: earlier failure")
    handle({"email_id": "em_copperfield"}, None, bedrock=FakeBedrock([stage_turn(FIELDS)]))
    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["status"] == "PARSED" and email["error"] is None


def seed_deal(aws, deal_id: str, status: str, email_id: str = "em_copperfield") -> None:
    aws.deals.put_item(
        Item={
            "deal_id": deal_id,
            "email_id": email_id,
            "opportunity_name": "Copperfield refinancing TLB",
            "status": status,
            "fields": {},
            "original_fields": {},
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


def test_reparse_supersedes_the_open_deals_of_the_email_and_leaves_closed_ones(aws):
    seed_email(aws, status="PARSED", deal_id="dl_old_staged")
    seed_deal(aws, "dl_old_staged", "STAGED")
    seed_deal(aws, "dl_old_approved", "APPROVED")
    seed_deal(aws, "dl_old_failed", "UPLOAD_FAILED")
    seed_deal(aws, "dl_old_uploaded", "UPLOADED")
    seed_deal(aws, "dl_old_rejected", "REJECTED")
    seed_deal(aws, "dl_other_email", "STAGED", email_id="em_other")

    result = handle({"email_id": "em_copperfield"}, None, bedrock=FakeBedrock([stage_turn(FIELDS)]))

    new_id = result["deal_id"]
    new_deal = aws.deals.get_item(Key={"deal_id": new_id})["Item"]
    assert new_deal["status"] == "STAGED"
    assert aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]["deal_id"] == new_id

    superseded = {"dl_old_staged", "dl_old_approved", "dl_old_failed"}
    for deal_id in superseded:
        deal = aws.deals.get_item(Key={"deal_id": deal_id})["Item"]
        assert deal["status"] == "REJECTED", deal_id
        assert deal["updated_at"] == new_deal["created_at"]
        assert deal["history"][-1] == {
            "at": new_deal["created_at"],
            "actor": "parser",
            "action": "REJECTED",
            "detail": f"superseded by {new_id}",
        }
    detail = new_deal["history"][0]["detail"]
    assert detail.startswith("Parsed with ") and "; supersedes " in detail
    assert set(detail.split("; supersedes ")[1].split(", ")) == superseded

    # UPLOADED is history the OMS already has, REJECTED is already closed, other emails are not ours.
    for deal_id, status in (
        ("dl_old_uploaded", "UPLOADED"),
        ("dl_old_rejected", "REJECTED"),
        ("dl_other_email", "STAGED"),
    ):
        deal = aws.deals.get_item(Key={"deal_id": deal_id})["Item"]
        assert deal["status"] == status and len(deal["history"]) == 1, deal_id
        assert deal["updated_at"] == "2026-08-05T14:00:00Z"


def test_failed_reparse_leaves_the_previous_deal_open(aws):
    seed_email(aws, status="PARSED", deal_id="dl_old_staged")
    seed_deal(aws, "dl_old_staged", "STAGED")
    result = handle(
        {"email_id": "em_copperfield"},
        None,
        bedrock=FakeBedrock([RuntimeError("model unavailable")]),
    )
    assert result["status"] == "PARSE_FAILED"
    assert aws.deals.get_item(Key={"deal_id": "dl_old_staged"})["Item"]["status"] == "STAGED"


def test_too_little_lambda_time_left_is_recorded_as_parse_failed(aws):
    seed_email(aws)
    bedrock = FakeBedrock([stage_turn(FIELDS)])
    # 15 s remaining is inside the 20 s safety margin: the loop must not start a model call.
    result = handle({"email_id": "em_copperfield"}, lambda_context(15_000), bedrock=bedrock)
    assert result["status"] == "PARSE_FAILED" and result["deal_id"] is None
    assert result["error"].startswith("TimeoutError: out of time before model round 1")
    assert bedrock.calls == []
    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["status"] == "PARSE_FAILED" and email["error"] == result["error"]
    assert aws.deals.scan()["Count"] == 0


def test_a_context_with_ample_time_parses_normally(aws):
    seed_email(aws)
    result = handle(
        {"email_id": "em_copperfield"},
        lambda_context(300_000),
        bedrock=FakeBedrock([stage_turn(FIELDS)]),
    )
    assert result["status"] == "PARSED"


def test_parse_deadline_keeps_a_safety_margin_before_the_lambda_timeout():
    assert parser_handler.parse_deadline(None) is None
    assert parser_handler.parse_deadline(object()) is None  # a context without the method
    deadline = parser_handler.parse_deadline(lambda_context(300_000), clock=lambda: 1000.0)
    assert deadline == 1000.0 + 300.0 - parser_handler.DEADLINE_MARGIN_SECONDS


def test_truncated_model_output_is_recorded_as_parse_failed(aws):
    seed_email(aws)
    result = handle({"email_id": "em_copperfield"}, None, bedrock=FakeBedrock([truncated_turn()]))
    assert result["status"] == "PARSE_FAILED"
    assert result["error"].startswith("ModelOutputTruncated: model output truncated")
    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["status"] == "PARSE_FAILED" and email["deal_id"] is None
    assert aws.deals.scan()["Count"] == 0


@pytest.mark.parametrize(
    ("source_kind", "expected"),
    [
        ("bank-notice", ["bank-notice-format", "deal-parsing", "oms-csv-format"]),
        ("news-alert", ["deal-parsing", "news-alert-format", "oms-csv-format"]),
        ("manual", ["bank-notice-format", "deal-parsing", "news-alert-format", "oms-csv-format"]),
    ],
)
def test_format_skills_load_only_for_their_source_kind(aws, source_kind, expected):
    seed_email(aws, source_kind=source_kind)
    for name, body in TIERED_SKILLS.items():
        aws.s3.put_object(Bucket=aws.bucket, Key=f"skills/{name}/SKILL.md", Body=body)
    bedrock = FakeBedrock([stage_turn(FIELDS)])

    handle({"email_id": "em_copperfield"}, None, bedrock=bedrock)

    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["parse"]["skills_used"] == expected
    prompt = bedrock.calls[0]["messages"][0]["content"][0]["text"]
    assert sorted(n for n in TIERED_SKILLS if f"## Skill: {n}\n" in prompt) == expected


def test_date_arrived_uses_the_desk_time_zone_from_the_environment(aws, monkeypatch):
    # No usable Sent header; received at 23:30 UTC, which is already the next day in London.
    seed_email(aws, sent=None, received_at="2026-08-05T23:30:00Z")
    monkeypatch.setenv("DESK_TZ", "Europe/London")
    handle({"email_id": "em_copperfield"}, None, bedrock=FakeBedrock([stage_turn(FIELDS)]))
    email = aws.emails.get_item(Key={"email_id": "em_copperfield"})["Item"]
    assert email["parse"]["fields"]["date_arrived"] == "8/6/2026"
    assert "Europe/London" in email["parse"]["evidence"]["date_arrived"]["rule"]
