"""Every sample email flows through the agent (scripted model) and yields a well-formed ParseOutput.

Structure only: the fake model returns a minimal stage_deal payload derived from the subject line,
so what is under test is the plumbing around the model -- prompt assembly with the real email
text, issuer lookup against the shipped security master, date defaults, normalization, CSV
round-trip -- not extraction quality.
"""

import pytest

from backend.deal_pipeline.agent import parse_email
from backend.deal_pipeline.coerce import money_to_mm, to_date
from backend.deal_pipeline.oms_schema import (
    FIELD_KEYS,
    FIELD_LABELS,
    parse_csv,
    to_csv,
    validate_fields,
)
from tests.fakes.bedrock import FakeBedrock, lookup_turn, stage_turn

SKILLS = [
    {"name": "deal-parsing", "description": "Parse deal emails.", "body": "Term loans are Loan."}
]


def scripted_fields(email: dict, issuer: str) -> dict:
    is_bond = "notes" in email["subject"].lower()
    return {
        "pipeline_type": "Bond" if is_bond else "Loan",
        "security_type": "Bond" if is_bond else "Loan",
        "opportunity_name": f"{issuer.split()[0]} {'secured notes' if is_bond else 'TLB'}",
        "currency": "USD",
        "issue_size_mm": money_to_mm(email["subject"]),
        "maturity_terms": "7 yr",
        "fixed_floating": "Fixed" if is_bond else "Floating",
    }


@pytest.mark.parametrize("index", range(7))
def test_sample_email_parses_to_a_valid_record(sample_emails, security_master, index):
    email = sample_emails[index]
    issuer = security_master.match_issuer(email["subject"])["issuer_name"]
    bedrock = FakeBedrock([lookup_turn(issuer), stage_turn(scripted_fields(email, issuer))])

    out = parse_email(
        email,
        model_id="test-model",
        system_prompt="system",
        skills=SKILLS,
        memories=[],
        security_master=security_master,
        bedrock=bedrock,
    )

    assert set(out) == {
        "fields",
        "evidence",
        "assumptions",
        "memory_hits",
        "skills_used",
        "enrichment",
        "model_id",
        "duration_ms",
    }
    assert list(out["fields"]) == FIELD_KEYS
    assert validate_fields(out["fields"]) == {}
    assert out["fields"]["date_arrived"] == to_date(email["received_at"], email["received_at"])
    assert out["enrichment"]["issuer_match"] == issuer
    assert set(out["enrichment"]["fields_from_security_master"]) >= {
        "region",
        "industry",
        "sponsors",
    }
    assert out["memory_hits"] == [] and out["skills_used"] == ["deal-parsing"]
    # The real email reached the model verbatim.
    prompt = bedrock.calls[0]["messages"][0]["content"][0]["text"]
    assert email["body"] in prompt and f"Subject: {email['subject']}" in prompt
    # And the record survives the CSV round trip the handlers rely on.
    labels, parsed = parse_csv(to_csv(out["fields"]))
    assert labels == FIELD_LABELS and parsed == out["fields"]


def test_corpus_has_seven_emails_with_the_expected_shape(sample_emails):
    assert len(sample_emails) == 7
    for email in sample_emails:
        assert email["source_kind"] in {"news-alert", "bank-notice"}
        assert email["subject"] and email["body"] and email["sent"]
