"""The Converse tool loop: prompt assembly, coercion, one correction turn, enrichment, robustness."""

import json
import time
from datetime import UTC, datetime

import pytest
from botocore.exceptions import ClientError

from backend.deal_pipeline import agent
from backend.deal_pipeline.agent import (
    INFERENCE_CONFIG,
    LOOKUP_TOOL,
    MAX_ROUNDS,
    STAGE_TOOL,
    ModelOutputTruncated,
    bedrock_client,
    build_user_message,
    parse_email,
    tool_config,
)
from backend.deal_pipeline.oms_schema import FIELD_KEYS, validate_fields
from tests.deal_pipeline.fakes import (
    FakeBedrock,
    lookup_turn,
    stage_turn,
    text_block,
    tool_use,
    truncated_turn,
)

EMAIL = {
    "email_id": "em_test",
    "from": "Market News Alerts <alerts@marketnews.example>",
    "to": "New Issues Desk <new-issues@example-firm.test>",
    "sent": "2026-08-10T09:42:00-04:00",
    "received_at": "2026-08-10T13:42:00Z",
    "subject": "Northwind Automotive launches $500M add-on TLB; commitments due Aug. 13",
    "body": "Northwind Automotive has launched a $500 million add-on term loan B ... priced at S+200.",
}
SKILLS = [{"name": "deal-parsing", "description": "d", "body": "Term loans are Loan."}]
MEMORIES = [{"record_id": "mem-1", "text": "Project-finance TLBs are First Lien in the OMS."}]

GOOD_FIELDS = {
    "pipeline_type": "Loan",
    "opportunity_name": "Northwind add-on TLB",
    "left_agent": "Harbor Point Securities",
    "commit_due": "8/13/2026",
    "commit_due_time": "12PM",
    "maturity_terms": "4.5 yr",
    "currency": "USD",
    "issue_size_mm": "500.000",
    "security_type": "Loan",
    "fixed_floating": "Floating",
    "initial_spread_talk_low": "2.000%",
    "initial_spread_talk_high": "2.000%",
}
EVIDENCE = {
    "issue_size_mm": {"value": "500.000", "confidence": "high", "excerpt": "$500 million add-on"},
    "commit_due": {
        "value": "8/13/2026",
        "confidence": "medium",
        "excerpt": "due Aug. 13",
        "rule": "year from email date",
    },
}


def run(bedrock, email=EMAIL, memories=MEMORIES, security_master=None, **overrides):
    return parse_email(
        email,
        model_id=overrides.get("model_id", "test-model"),
        system_prompt=overrides.get("system_prompt", "system prompt text"),
        skills=overrides.get("skills", SKILLS),
        memories=memories,
        security_master=security_master,
        bedrock=bedrock,
        deadline=overrides.get("deadline"),
        desk_tz=overrides.get("desk_tz"),
    )


def test_tool_config_is_generated_from_the_schema():
    config = tool_config()
    assert config["toolChoice"] == {"any": {}}
    names = [t["toolSpec"]["name"] for t in config["tools"]]
    assert names == [LOOKUP_TOOL, STAGE_TOOL]
    stage = config["tools"][1]["toolSpec"]["inputSchema"]["json"]
    assert stage["required"] == ["fields", "evidence", "assumptions"]
    assert list(stage["properties"]["fields"]["properties"]) == FIELD_KEYS
    assert stage["properties"]["fields"]["required"] == FIELD_KEYS
    currency = stage["properties"]["fields"]["properties"]["currency"]["description"]
    assert "one of: USD, EUR, GBP, CAD" in currency and "required by the OMS" in currency
    assert (
        "internal desk decision: leave blank"
        in stage["properties"]["fields"]["properties"]["trader"]["description"]
    )
    assert (
        'always "New"'
        in stage["properties"]["fields"]["properties"]["pipeline_status"]["description"]
    )
    json.dumps(config)  # must be serializable for the SDK


def test_first_user_message_orders_skills_memories_email_instructions():
    text = build_user_message(EMAIL, SKILLS, MEMORIES, EMAIL["sent"])
    skill_at = text.index("## Skill: deal-parsing\nTerm loans are Loan.")
    memory_at = text.index(
        "## Edge-case memories (advisory, apply when their condition matches)\n- Project-finance"
    )
    email_at = text.index("## Email\nFrom: Market News Alerts")
    instructions_at = text.index("## Instructions")
    assert skill_at < memory_at < email_at < instructions_at
    assert "Subject: Northwind Automotive launches" in text
    assert "Reference date for dates written without a year: 2026-08-10" in text
    assert "Cc:" not in text and "Source kind:" not in text
    assert (
        "none" in build_user_message(EMAIL, [], [], EMAIL["sent"]).split("## Edge-case memories")[1]
    )
    tagged = build_user_message({**EMAIL, "source_kind": "news-alert"}, SKILLS, [], EMAIL["sent"])
    assert "Subject: Northwind Automotive launches" in tagged
    assert "\nSource kind: news-alert\n" in tagged


def test_happy_path_lookup_then_stage(security_master):
    bedrock = FakeBedrock(
        [lookup_turn("Northwind Automotive"), stage_turn(GOOD_FIELDS, EVIDENCE, ["one"])]
    )
    out = run(bedrock, security_master=security_master)

    assert len(bedrock.calls) == 2
    first = bedrock.calls[0]
    assert first["modelId"] == "test-model"
    assert first["system"] == [{"text": "system prompt text"}]
    assert first["toolConfig"]["toolChoice"] == {"any": {}}
    assert first["inferenceConfig"] == INFERENCE_CONFIG and INFERENCE_CONFIG["maxTokens"] >= 8192
    # The lookup result went back as a toolResult carrying the matched issuer row.
    result_block = bedrock.calls[1]["messages"][-1]["content"][0]["toolResult"]
    assert result_block["toolUseId"] == "tu-lookup"
    assert result_block["content"][0]["json"]["match"]["issuer_name"] == "Northwind Automotive"
    assert "aliases" not in result_block["content"][0]["json"]["match"]

    assert list(out["fields"]) == FIELD_KEYS
    assert validate_fields(out["fields"]) == {}
    assert out["fields"]["pipeline_status"] == "New" and out["fields"]["pct_commit"] == "0.000%"
    assert out["fields"]["date_arrived"] == "8/10/2026"
    assert out["evidence"]["date_arrived"] == {
        "value": "8/10/2026",
        "confidence": "high",
        "excerpt": "Sent: 2026-08-10T09:42:00-04:00",
        "rule": "Date Arrived is the calendar date of the Sent header",
    }
    assert out["evidence"]["commit_due"] == EVIDENCE["commit_due"]
    assert out["assumptions"] == ["one"]
    assert out["memory_hits"] == [{"text": MEMORIES[0]["text"], "record_id": "mem-1"}]
    assert out["skills_used"] == ["deal-parsing"]
    assert out["model_id"] == "test-model"
    assert isinstance(out["duration_ms"], int)
    # Enrichment from the lookup the model used, medium confidence, rule "security master".
    assert out["enrichment"] == {
        "issuer_match": "Northwind Automotive",
        "fields_from_security_master": [
            "region",
            "industry",
            "sponsors",
            "asset",
            "liquidity_score",
        ],
    }
    assert out["fields"]["region"] == "North America" and out["fields"]["asset"] == "SM-100231"
    assert out["evidence"]["industry"] == {
        "value": "Automotive",
        "confidence": "medium",
        "excerpt": "security master: Northwind Automotive",
        "rule": "security master",
    }


def test_model_values_are_coerced_without_a_second_round(security_master):
    sloppy = {
        **GOOD_FIELDS,
        "issue_size_mm": "$500 million",
        "commit_due": "Aug. 13",
        "commit_due_time": "noon ET",
        "initial_spread_talk_low": "S+275-300",
        "initial_spread_talk_high": "S+275-300",
        "initial_price_talk_low": "99.5-99.75",
        "initial_price_talk_high": "99.5-99.75",
        "floor_talk": "0%",
        "maturity_terms": "7 Years",
        "uop": "refinance",
        "secured_level": "First Lien Term Loan",
        "covenant_status_num": "3 (cov-lite)",
        "priced": True,
        "is_investment_grade": "false",
    }
    evidence = {
        "issue_size_mm": {"value": "$500 million", "confidence": "high", "excerpt": "$500 million"}
    }
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(sloppy, evidence)])
    out = run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == 2
    f = out["fields"]
    assert (
        f["issue_size_mm"] == "500.000" and out["evidence"]["issue_size_mm"]["value"] == "500.000"
    )
    assert f["commit_due"] == "8/13/2026" and f["commit_due_time"] == "12PM"
    assert (f["initial_spread_talk_low"], f["initial_spread_talk_high"]) == ("2.750%", "3.000%")
    assert (f["initial_price_talk_low"], f["initial_price_talk_high"]) == ("99.500", "99.750")
    assert f["floor_talk"] == "0.000%" and f["maturity_terms"] == "7 yr"
    assert f["uop"] == "Refinance" and f["secured_level"] == "First Lien"
    assert (
        f["covenant_status_num"] == "3"
        and f["priced"] == "Yes"
        and f["is_investment_grade"] == "No"
    )
    assert validate_fields(f) == {}


def test_unfixable_values_trigger_one_correction_turn(security_master):
    bad = {**GOOD_FIELDS, "maturity_terms": "January 2031", "currency": ""}
    fixed = {**GOOD_FIELDS, "maturity_terms": "4.5 yr"}
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(bad), stage_turn(fixed)])
    out = run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == 3
    correction = bedrock.calls[2]["messages"][-1]["content"]
    assert "toolResult" in correction[0] and correction[0]["toolResult"]["toolUseId"] == "tu-stage"
    prompt = correction[-1]["text"]
    assert "Maturity Terms: 'January 2031' must match" in prompt
    assert "Currency: required but blank" in prompt
    assert out["fields"]["maturity_terms"] == "4.5 yr" and out["fields"]["currency"] == "USD"
    assert out["assumptions"] == []


def test_values_still_failing_after_the_retry_are_blanked_with_an_assumption(security_master):
    bad = {**GOOD_FIELDS, "commit_due_time": "close of business", "currency": ""}
    evidence = {
        "commit_due_time": {"value": "close of business", "confidence": "low", "excerpt": "by COB"}
    }
    bedrock = FakeBedrock(
        [lookup_turn("Northwind Automotive"), stage_turn(bad, evidence), stage_turn(bad, evidence)]
    )
    out = run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == 3  # exactly one retry, never two
    assert out["fields"]["commit_due_time"] == ""
    assert out["fields"]["currency"] == ""
    assert (
        "Left Commit Due Time blank: 'close of business' expected h[:mm]AM|PM, e.g. 12PM."
        in out["assumptions"]
    )
    assert "Currency is required but could not be determined from the email." in out["assumptions"]
    # The reviewer still sees what the model read.
    assert out["evidence"]["commit_due_time"]["value"] == "close of business"


def test_model_values_for_lookup_fields_are_kept_over_the_master(security_master):
    fields = {**GOOD_FIELDS, "region": "Europe", "industry": "Auto parts"}
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(fields)])
    out = run(bedrock, security_master=security_master)
    assert out["fields"]["region"] == "Europe" and out["fields"]["industry"] == "Auto parts"
    assert out["fields"]["sponsors"] == "Public"  # blank ones are still filled
    assert out["enrichment"]["fields_from_security_master"] == [
        "sponsors",
        "asset",
        "liquidity_score",
    ]


def test_unknown_issuer_lookup_returns_no_match_and_no_enrichment(security_master):
    bedrock = FakeBedrock([lookup_turn("Unknown Holdings"), stage_turn(GOOD_FIELDS)])
    email = {
        **EMAIL,
        "subject": "Unknown Holdings launches a TLB",
        "body": "Unknown Holdings, a borrower.",
    }
    out = run(bedrock, email=email, security_master=security_master)
    payload = bedrock.calls[1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["json"]
    assert payload["match"] is None and "Unknown Holdings" in payload["message"]
    assert out["enrichment"] == {"issuer_match": None, "fields_from_security_master": []}
    assert out["fields"]["region"] == ""


def test_skipped_lookup_falls_back_to_matching_the_email_text(security_master):
    bedrock = FakeBedrock([stage_turn(GOOD_FIELDS)])
    out = run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == 1
    assert out["enrichment"]["issuer_match"] == "Northwind Automotive"
    assert out["fields"]["industry"] == "Automotive"
    assert any("matched by the pipeline" in a and LOOKUP_TOOL in a for a in out["assumptions"])


def test_internal_fields_filled_by_the_model_are_reset_to_the_desk_defaults(security_master):
    fields = {
        **GOOD_FIELDS,
        "trader": "someone",
        "commit_amount_mm": "25.000",
        "pipeline_status": "Play",  # an allowed enum value, but a desk decision (design section 5)
        "pct_commit": "5.000%",
    }
    evidence = {
        "trader": {"value": "someone", "confidence": "high", "excerpt": "x"},
        "pipeline_status": {"value": "Play", "confidence": "high", "excerpt": "we should play"},
    }
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(fields, evidence)])
    out = run(bedrock, security_master=security_master)
    assert out["fields"]["trader"] == "" and out["fields"]["commit_amount_mm"] == ""
    assert out["fields"]["pipeline_status"] == "New" and out["fields"]["pct_commit"] == "0.000%"
    assert "trader" not in out["evidence"] and "pipeline_status" not in out["evidence"]
    assert out["assumptions"] == [
        "Reset internal-decision fields the model filled to the desk defaults (the desk sets "
        "these): Pipeline Status, Trader, Commit Amount (MM), % Commit"
    ]


def test_internal_fields_at_their_defaults_or_blank_record_no_override(security_master):
    fields = {**GOOD_FIELDS, "pipeline_status": "new", "pct_commit": "", "trader": ""}
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(fields)])
    out = run(bedrock, security_master=security_master)
    assert out["fields"]["pipeline_status"] == "New" and out["fields"]["pct_commit"] == "0.000%"
    assert out["assumptions"] == []


def test_evidence_is_normalized_defensively(security_master):
    evidence = {
        "issue_size_mm": {"value": 500, "confidence": "certain", "excerpt": None, "rule": ""},
        "commit_due": "Aug. 13",
        "not_a_field": {"value": "x", "confidence": "high", "excerpt": "y"},
    }
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(GOOD_FIELDS, evidence)])
    out = run(bedrock, security_master=security_master)
    assert out["evidence"]["issue_size_mm"] == {
        "value": "500.000",
        "confidence": "low",
        "excerpt": "",
    }
    assert out["evidence"]["commit_due"] == {
        "value": "8/13/2026",
        "confidence": "low",
        "excerpt": "Aug. 13",
    }
    assert "not_a_field" not in out["evidence"]


def test_text_only_reply_is_nudged_and_unknown_tools_get_an_error_result(security_master):
    bedrock = FakeBedrock(
        [
            [text_block("Let me think.")],
            [tool_use("make_coffee", {}, "tu-x"), lookup_turn("Northwind Automotive")[0]],
            stage_turn(GOOD_FIELDS),
        ]
    )
    out = run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == 3
    assert f"Call {STAGE_TOOL} now" in bedrock.user_text(1)
    results = [
        b["toolResult"] for b in bedrock.calls[2]["messages"][-1]["content"] if "toolResult" in b
    ]
    assert results[0]["status"] == "error" and "unknown tool make_coffee" in json.dumps(
        results[0]["content"]
    )
    assert "status" not in results[1]
    assert out["fields"]["opportunity_name"] == "Northwind add-on TLB"


def test_model_that_never_stages_yields_a_blank_record_after_max_rounds(security_master):
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive")] * MAX_ROUNDS)
    out = run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == MAX_ROUNDS
    assert out["fields"]["pipeline_status"] == "New" and out["fields"]["opportunity_name"] == ""
    assert out["assumptions"] == [f"The model did not stage a deal within {MAX_ROUNDS} rounds."]
    assert out["enrichment"] == {"issuer_match": None, "fields_from_security_master": []}
    assert out["skills_used"] == ["deal-parsing"] and out["memory_hits"][0]["record_id"] == "mem-1"


def test_transport_errors_propagate(security_master):
    error = ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "Converse"
    )
    with pytest.raises(ClientError):
        run(FakeBedrock([error]), security_master=security_master)


def test_reference_date_falls_back_to_the_clock_when_the_email_has_no_dates(security_master):
    email = {k: v for k, v in EMAIL.items() if k not in ("sent", "received_at")}
    bedrock = FakeBedrock([stage_turn({**GOOD_FIELDS, "commit_due": "Aug. 13"})])
    out = parse_email(
        email,
        model_id="m",
        system_prompt="s",
        skills=[],
        memories=[],
        security_master=security_master,
        bedrock=bedrock,
        # 02:00 UTC on Aug 2 is still Aug 1 at the desk: the clock is a UTC instant like any other.
        now=lambda: datetime(2026, 8, 2, 2, 0, tzinfo=UTC),
    )
    assert out["fields"]["date_arrived"] == "8/1/2026"
    assert out["evidence"]["date_arrived"]["rule"] == "Date Arrived is the parse date"
    assert out["fields"]["commit_due"] == "8/13/2026"
    assert "Reference date for dates written without a year: 2026-08-01" in bedrock.user_text(0)


@pytest.mark.parametrize(
    "sent", ["8/5/2026", "Aug 5, 2026 9:58 AM", "Tue, 05 Aug 2026 09:58:00 -0400"]
)
def test_non_iso_sent_falls_back_to_received_at_instead_of_failing(security_master, sent):
    # The BFF's Date.parse check lets these through; the parse must degrade, not crash.
    email = {**EMAIL, "sent": sent, "received_at": "2026-08-05T13:58:00Z"}
    bedrock = FakeBedrock([stage_turn({**GOOD_FIELDS, "commit_due": "Aug. 13"})])
    out = run(bedrock, email=email, security_master=security_master)
    assert out["fields"]["date_arrived"] == "8/5/2026"
    assert out["evidence"]["date_arrived"]["excerpt"] == "Received: 2026-08-05T13:58:00Z"
    assert out["fields"]["commit_due"] == "8/13/2026"
    assert "Reference date for dates written without a year: 2026-08-05" in bedrock.user_text(0)


@pytest.mark.parametrize(
    ("sent", "received_at", "desk_tz", "expected", "header"),
    [
        # 8:30 PM Eastern lands at 00:30 UTC the next day; the desk still writes Aug 5.
        (None, "2026-08-06T00:30:00Z", None, "8/5/2026", "Received"),
        (None, "2026-08-06T00:30:00.000Z", None, "8/5/2026", "Received"),
        # The in-app form serializes sent with toISOString, so a UTC sent is the same wire form.
        ("2026-08-06T00:30:00.000Z", "2026-08-06T00:30:05Z", None, "8/5/2026", "Sent"),
        # A sender's own offset is kept as written: their calendar date is the one that counts.
        ("2026-08-05T20:30:00-04:00", "2026-08-06T00:30:00Z", None, "8/5/2026", "Sent"),
        ("2026-08-06T01:30:00+01:00", "2026-08-06T00:30:00Z", None, "8/6/2026", "Sent"),
        # No offset at all reads as desk-local.
        ("2026-08-05T20:30:00", "2026-08-06T00:30:00Z", None, "8/5/2026", "Sent"),
        # A different desk zone (BST is UTC+1 in August).
        (None, "2026-08-05T23:30:00Z", "Europe/London", "8/6/2026", "Received"),
    ],
)
def test_date_arrived_is_the_desk_calendar_date(
    security_master, sent, received_at, desk_tz, expected, header
):
    email = {k: v for k, v in EMAIL.items() if k != "sent"}
    email["received_at"] = received_at
    if sent is not None:
        email["sent"] = sent
    bedrock = FakeBedrock([stage_turn(GOOD_FIELDS)])
    out = run(bedrock, email=email, security_master=security_master, desk_tz=desk_tz)
    assert out["fields"]["date_arrived"] == expected
    assert out["evidence"]["date_arrived"]["excerpt"].startswith(f"{header}: ")
    # Year inference works from the same calendar date, so the two can never disagree.
    assert f"Reference date for dates written without a year: {_iso_date(expected)}" in (
        bedrock.user_text(0)
    )


def _iso_date(mdy: str) -> str:
    month, day, year = mdy.split("/")
    return f"{year}-{int(month):02d}-{int(day):02d}"


@pytest.mark.parametrize(
    "turn",
    [
        truncated_turn(),  # text only: the tool call never started
        truncated_turn([tool_use(STAGE_TOOL, {}, "tu-stage")]),  # tool call cut to an empty input
    ],
)
def test_reply_truncated_at_max_tokens_raises_instead_of_staging_a_hollow_record(
    security_master, turn
):
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), turn])
    with pytest.raises(ModelOutputTruncated, match="model output truncated"):
        run(bedrock, security_master=security_master)
    assert len(bedrock.calls) == 2  # no nudge, no retry with the same budget


def test_deadline_already_passed_raises_before_the_first_model_call(security_master):
    bedrock = FakeBedrock([stage_turn(GOOD_FIELDS)])
    with pytest.raises(TimeoutError, match="before model round 1"):
        run(bedrock, security_master=security_master, deadline=time.monotonic() - 1)
    assert bedrock.calls == []


def test_deadline_is_checked_before_every_round(security_master, monkeypatch):
    clock = iter([100.0, 130.0])  # read once per round, just before converse: round 1, round 2
    monkeypatch.setattr(agent.time, "monotonic", lambda: next(clock))
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(GOOD_FIELDS)])
    with pytest.raises(TimeoutError, match="before model round 2"):
        run(bedrock, security_master=security_master, deadline=120.0)
    assert len(bedrock.calls) == 1


def test_no_deadline_means_no_limit(security_master):
    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn(GOOD_FIELDS)])
    out = run(bedrock, security_master=security_master, deadline=None)
    assert out["fields"]["opportunity_name"] == "Northwind add-on TLB"


def test_unknown_desk_zone_falls_back_to_the_default_instead_of_failing(security_master):
    email = {k: v for k, v in EMAIL.items() if k != "sent"} | {
        "received_at": "2026-08-06T00:30:00Z"
    }
    bedrock = FakeBedrock([stage_turn(GOOD_FIELDS)])
    out = run(bedrock, email=email, security_master=security_master, desk_tz="Mars/Olympus_Mons")
    assert out["fields"]["date_arrived"] == "8/5/2026"  # the default desk zone, Eastern


def test_bedrock_client_is_built_with_bounded_timeouts_and_retries(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    config = bedrock_client().meta.config
    assert config.read_timeout == 120 and config.connect_timeout == 10
    # botocore counts client-config max_attempts as retries: 2 retries, 3 attempts in total.
    assert config.retries == {"total_max_attempts": 3, "mode": "standard"}
