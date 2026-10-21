"""Fixtures for the deal pipeline tests: fictional reference data, the sample corpus, mocked AWS."""

import json
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from backend.deal_pipeline.oms_schema import normalize_fields
from backend.deal_pipeline.security_master import SecurityMaster
from tests.fakes.ddb import make_table

REPO_ROOT = Path(__file__).resolve().parents[2]
SECURITY_MASTER_DIR = REPO_ROOT / "data" / "security-master"
SAMPLE_EMAILS_DIR = REPO_ROOT / "data" / "deal-emails"

BUCKET = "deal-pipeline-test-assets"
EMAILS_TABLE = "deal-pipeline-test-emails"
DEALS_TABLE = "deal-pipeline-test-deals"
MODEL_PARAM = "/deal-pipeline-test/agent-model-id"


@pytest.fixture
def security_master() -> SecurityMaster:
    """The fictional issuers and counterparties shipped in ``data/security-master``."""
    return SecurityMaster.from_directory(SECURITY_MASTER_DIR)


@pytest.fixture
def sample_emails() -> list[dict]:
    """The seven sample emails as email records (``email_id`` and ``received_at`` added)."""
    emails = []
    for path in sorted(SAMPLE_EMAILS_DIR.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        emails.append({**raw, "email_id": f"em_{raw['id']}", "received_at": raw["sent"]})
    return emails


def clean_loan_fields() -> dict[str, str]:
    """A Loan record that passes every mock-OMS rule (the Copperfield refinancing, fully corrected)."""
    return normalize_fields(
        {
            "pipeline_status": "New",
            "pipeline_type": "Loan",
            "opportunity_name": "Copperfield refinancing TLB",
            "region": "North America",
            "sponsors": "Granite Peak Capital / Tidewater Partners / Meadowbrook Equity",
            "left_agent": "Silverline",
            "industry": "Insurance Brokerage",
            "priced": "No",
            "date_arrived": "8/5/2026",
            "launch_date": "8/5/2026",
            "commit_due": "8/13/2026",
            "commit_due_time": "12PM",
            "maturity_terms": "7 yr",
            "currency": "USD",
            "issue_size_mm": "1295.000",
            "is_secured": "Yes",
            "secured_level": "First Lien",
            "security_type": "Loan",
            "uop": "Refinance",
            "covenant_status_num": "3",
            "fixed_floating": "Floating",
            "floor_talk": "0.000%",
            "sp_issue_rating": "B",
            "moodys_issue_rating": "B3",
            "sp_corp_rating": "B",
            "moodys_corp_rating": "B3",
            "liquidity_score": "4",
            "is_investment_grade": "No",
            "pct_commit": "0.000%",
        }
    )


def clean_bond_fields() -> dict[str, str]:
    """A Bond record that passes every mock-OMS rule (the Ridgeline secured notes)."""
    return normalize_fields(
        {
            "pipeline_status": "New",
            "pipeline_type": "Bond",
            "opportunity_name": "Ridgeline senior secured notes",
            "region": "North America",
            "sponsors": "Tidewater Partners",
            "left_agent": "Northgate",
            "industry": "Packaging",
            "priced": "No",
            "date_arrived": "9/8/2026",
            "maturity_terms": "8 yr",
            "currency": "USD",
            "issue_size_mm": "600.000",
            "is_secured": "Yes",
            "secured_level": "Senior Secured",
            "security_type": "Bond",
            "uop": "Acquisition",
            "fixed_floating": "Fixed",
            "initial_spread_talk_low": "7.250%",
            "initial_spread_talk_high": "7.500%",
            "sp_issue_rating": "B+",
            "moodys_issue_rating": "B2",
            "is_investment_grade": "No",
            "pct_commit": "0.000%",
        }
    )


@pytest.fixture
def pipeline_env(monkeypatch) -> None:
    """Every environment variable the two handlers read, pointed at the mocked resources."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("EMAILS_TABLE", EMAILS_TABLE)
    monkeypatch.setenv("DEALS_TABLE", DEALS_TABLE)
    monkeypatch.setenv("ASSETS_BUCKET", BUCKET)
    monkeypatch.setenv("KNOWLEDGE_MEMORY_ID", "")
    monkeypatch.setenv("AGENT_MODEL_PARAM", MODEL_PARAM)
    monkeypatch.setenv("SKILLS_PREFIX", "skills/")
    monkeypatch.setenv("PARSER_PROMPT_KEY", "prompts/parser-system.md")
    monkeypatch.setenv("SECURITY_MASTER_PREFIX", "security-master/")
    monkeypatch.setenv("COUNTERPARTIES_KEY", "security-master/counterparties.csv")


@pytest.fixture
def aws(pipeline_env):
    """Mocked DynamoDB tables, assets bucket (security master seeded) and SSM, torn down after.

    The deals table carries the ``by_email`` index of design section 4 (as Terraform creates it)
    because the parser queries it on re-parse.
    """
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        emails = make_table(EMAILS_TABLE, "email_id")
        deals = make_table(DEALS_TABLE, "deal_id", gsis=(("by_email", "email_id"),))
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        for name in ("issuers.csv", "counterparties.csv"):
            s3.put_object(
                Bucket=BUCKET,
                Key=f"security-master/{name}",
                Body=(SECURITY_MASTER_DIR / name).read_bytes(),
            )
        yield SimpleNamespace(
            ddb=ddb,
            emails=emails,
            deals=deals,
            s3=s3,
            ssm=boto3.client("ssm", region_name="us-east-1"),
            bucket=BUCKET,
        )
