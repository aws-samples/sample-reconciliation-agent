"""Schema parity with the frontend, value validation messages, CSV round-trip and quoting."""

from pathlib import Path

import pytest

from backend.deal_pipeline import oms_schema
from backend.deal_pipeline.oms_schema import (
    FIELD_KEYS,
    FIELD_LABELS,
    FIELDS,
    apply_defaults,
    by_key,
    empty_fields,
    key_for_label,
    normalize_fields,
    parse_csv,
    to_csv,
    validate_fields,
    validate_value,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_COPY = REPO_ROOT / "chatbot-app/frontend/src/lib/pipeline/omsFields.json"


def test_frontend_schema_copy_is_byte_identical():
    """The BFF formats and validates with its own copy; the two must never drift."""
    backend_bytes = (REPO_ROOT / "backend/deal_pipeline/oms_fields.json").read_bytes()
    assert backend_bytes == FRONTEND_COPY.read_bytes()


def test_field_order_and_lookup():
    assert len(FIELD_KEYS) == len(set(FIELD_KEYS)) == len(FIELDS)
    assert FIELD_KEYS[:3] == ["pipeline_status", "pipeline_type", "opportunity_name"]
    assert FIELD_KEYS[-1] == "allocation_comments"
    assert by_key("issue_size_mm")["type"] == "mm"
    assert by_key("nope") is None
    assert key_for_label("Issue Size (MM)") == "issue_size_mm"
    assert key_for_label("Nope") is None
    sections = [s for s, fields in oms_schema.fields_by_section() if fields]
    assert sections == oms_schema.SECTIONS


@pytest.mark.parametrize(
    ("key", "value", "expected"),
    [
        ("currency", "", "required"),
        ("region", "", None),
        ("currency", "usd", "must be one of USD, EUR, GBP, CAD"),
        ("currency", "USD", None),
        ("opportunity_name", "x" * 61, "longer than 60 characters"),
        ("opportunity_name", "x" * 60, None),
        ("maturity_terms", "7 years", "must match ^\\d+(\\.\\d+)? yr$"),
        ("maturity_terms", "4.5 yr", None),
        ("covenant_status_num", "three", "must be a whole number"),
        ("covenant_status_num", "0", "must be ≥ 1"),
        ("covenant_status_num", "5", "must be ≤ 4"),
        ("covenant_status_num", "3", None),
        ("date_arrived", "08/13/2026", "expected M/D/YYYY"),
        ("date_arrived", "8/13/2026", None),
        ("commit_due_time", "12:00 PM", "expected h[:mm]AM|PM, e.g. 12PM"),
        ("commit_due_time", "1:15PM", None),
        ("floor_talk", "0%", "expected 0.000%"),
        ("floor_talk", "-0.500%", None),
        ("issue_size_mm", "500", "expected millions with 3 decimals, e.g. 500.000"),
        ("issue_size_mm", "500.000", None),
        ("initial_price_talk_low", "99.5", "expected 3 decimals, e.g. 99.500"),
        ("priced", "yes", "expected Yes or No"),
        ("priced", " Yes ", None),
        ("notes", None, None),
    ],
)
def test_validate_value_matches_typescript_messages(key, value, expected):
    assert validate_value(by_key(key), value) == expected


def test_normalize_and_defaults():
    assert empty_fields()["pipeline_status"] == "New"
    assert empty_fields()["pct_commit"] == "0.000%"
    out = normalize_fields(
        {"issue_size_mm": 500, "notes": None, "unknown_key": "x", "pipeline_status": ""}
    )
    assert out["issue_size_mm"] == "500"
    assert out["notes"] == ""
    assert "unknown_key" not in out
    assert list(out) == FIELD_KEYS
    # An explicit blank wins in normalize (the caller said "blank"); apply_defaults restores it.
    assert out["pipeline_status"] == ""
    assert apply_defaults(out)["pipeline_status"] == "New"
    assert normalize_fields(None) == empty_fields()


def test_validate_fields_reports_every_problem():
    problems = validate_fields(normalize_fields({"currency": "usd"}))
    assert problems["currency"].startswith("must be one of")
    assert problems["pipeline_type"] == "required"
    assert "region" not in problems


def test_to_csv_golden():
    fields = normalize_fields(
        {
            "pipeline_type": "Loan",
            "opportunity_name": "Northwind add-on TLB",
            "date_arrived": "8/10/2026",
            "maturity_terms": "4.5 yr",
            "currency": "USD",
            "issue_size_mm": "500.000",
            "security_type": "Loan",
            "fixed_floating": "Floating",
        }
    )
    text = to_csv(fields)
    header, row, trailing = text.split("\n")
    assert trailing == ""  # exactly one "\n" after the data row, no "\r"
    assert header.startswith("Pipeline Status,Pipeline Type,Opportunity Name,Region,Sponsors,")
    assert header == ",".join(FIELD_LABELS)
    cells = row.split(",")
    assert len(cells) == len(FIELDS)
    assert cells[FIELD_KEYS.index("pipeline_status")] == "New"
    assert cells[FIELD_KEYS.index("opportunity_name")] == "Northwind add-on TLB"
    assert cells[FIELD_KEYS.index("pct_commit")] == "0.000%"
    assert cells[FIELD_KEYS.index("region")] == ""


def test_to_csv_quotes_like_rfc_4180():
    fields = normalize_fields(
        {"opportunity_name": 'He said "hi", ok', "notes": "line one\nline two", "trader": "plain"}
    )
    row = to_csv(fields).split("\n", 1)[1]
    assert '"He said ""hi"", ok"' in row
    assert '"line one\nline two"' in row
    assert ",plain," in row


def test_parse_csv_round_trip_and_header_passthrough():
    fields = normalize_fields({"pipeline_type": "Loan", "notes": 'a "quoted", note'})
    labels, parsed = parse_csv(to_csv(fields))
    assert labels == FIELD_LABELS
    assert parsed == fields


def test_parse_csv_maps_by_label_and_keeps_unknown_header_for_the_validator():
    labels, parsed = parse_csv("Opportunity Name,Mystery,Pipeline Type\nNorthwind,42,Loan\n")
    assert labels == ["Opportunity Name", "Mystery", "Pipeline Type"]
    assert parsed == {"opportunity_name": "Northwind", "pipeline_type": "Loan"}


@pytest.mark.parametrize(
    "text",
    ["", "Pipeline Status,Pipeline Type\n", "Pipeline Status,Pipeline Type\nNew\n"],
)
def test_parse_csv_rejects_unreadable_files(text):
    with pytest.raises(ValueError):
        parse_csv(text)
