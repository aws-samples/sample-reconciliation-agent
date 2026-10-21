"""Mock OMS rules, one by one, with the exact codes of design section 6 and their hints."""

import pytest

from backend.deal_pipeline.oms_schema import FIELD_LABELS
from backend.deal_pipeline.oms_validator import VALIDATOR_VERSION, validate
from tests.deal_pipeline.conftest import clean_bond_fields, clean_loan_fields


def codes(errors):
    return sorted(e["code"] for e in errors)


def only(errors, code):
    matching = [e for e in errors if e["code"] == code]
    assert matching, f"{code} not raised; got {codes(errors)}"
    return matching


def test_version_pin():
    assert VALIDATOR_VERSION == "2026.09.1"


def test_clean_records_are_accepted(security_master):
    assert validate(clean_loan_fields(), FIELD_LABELS, security_master) == []
    assert validate(clean_bond_fields(), FIELD_LABELS, security_master) == []


def test_header_mismatch_reports_count_or_first_differing_column(security_master):
    short = validate(clean_loan_fields(), FIELD_LABELS[:-1], security_master)
    error = only(short, "HEADER_MISMATCH")[0]
    assert error["field"] is None
    assert (
        f"expected {len(FIELD_LABELS)} columns, found {len(FIELD_LABELS) - 1}" in error["message"]
    )

    swapped = list(FIELD_LABELS)
    swapped[3], swapped[4] = swapped[4], swapped[3]
    error = only(validate(clean_loan_fields(), swapped, security_master), "HEADER_MISMATCH")[0]
    assert "column 4 is 'Sponsors', expected 'Region'" in error["message"]
    assert "template" in error["hint"]


def test_required_missing(security_master):
    fields = clean_loan_fields()
    fields["currency"] = ""
    error = only(validate(fields, FIELD_LABELS, security_master), "REQUIRED_MISSING")[0]
    assert error["field"] == "currency"
    assert "'Currency' is required" in error["message"]


def test_format_invalid_names_the_expected_format(security_master):
    fields = clean_loan_fields()
    fields["commit_due_time"] = "12:00 PM ET"
    fields["issue_size_mm"] = "$1,295 million"
    fields["maturity_terms"] = "7 years"
    errors = only(validate(fields, FIELD_LABELS, security_master), "FORMAT_INVALID")
    by_field = {e["field"]: e for e in errors}
    assert set(by_field) == {"commit_due_time", "issue_size_mm", "maturity_terms"}
    assert "h[:mm]AM|PM" in by_field["commit_due_time"]["hint"]
    assert "500.000" in by_field["issue_size_mm"]["hint"]
    assert "must match" in by_field["maturity_terms"]["hint"]


def test_enum_invalid_lists_allowed_values(security_master):
    fields = clean_loan_fields()
    fields["secured_level"] = "Senior Secured First Lien"
    error = only(validate(fields, FIELD_LABELS, security_master), "ENUM_INVALID")[0]
    assert error["field"] == "secured_level"
    assert "Senior Secured, First Lien, Second Lien" in error["hint"]


@pytest.mark.parametrize(
    ("name", "reason"),
    [
        ("Copperfield $1,295MM Term Loan B Refinancing", "currency symbol"),
        ("Copperfield 1,295MM TLB refinancing", "deal amount"),
        ("Copperfield 500 million TLB", "deal amount"),
        ("C" * 61, "61 characters"),
    ],
)
def test_opportunity_name_invalid(security_master, name, reason):
    fields = clean_loan_fields()
    fields["opportunity_name"] = name
    errors = validate(fields, FIELD_LABELS, security_master)
    error = only(errors, "OPP_NAME_INVALID")[0]
    assert reason in error["message"]
    assert "FORMAT_INVALID" not in codes(errors)  # length is reported once, under the name rule


def test_opportunity_name_allows_deal_types_with_digits(security_master):
    fields = clean_loan_fields()
    fields["opportunity_name"] = "Copperfield 7yr TLB refinancing"
    assert validate(fields, FIELD_LABELS, security_master) == []


def test_covenant_status_required_for_loans_only(security_master):
    fields = clean_loan_fields()
    fields["covenant_status_num"] = ""
    error = only(validate(fields, FIELD_LABELS, security_master), "COVENANT_STATUS_REQUIRED")[0]
    assert error["field"] == "covenant_status_num"
    assert "3 = cov-lite" in error["hint"]
    bond = clean_bond_fields()
    assert bond["covenant_status_num"] == ""
    assert "COVENANT_STATUS_REQUIRED" not in codes(validate(bond, FIELD_LABELS, security_master))


def test_left_agent_unknown_names_the_nearest_canonical(security_master):
    fields = clean_loan_fields()
    fields["left_agent"] = "Silverline Partners"
    error = only(validate(fields, FIELD_LABELS, security_master), "LEFT_AGENT_UNKNOWN")[0]
    assert error["field"] == "left_agent"
    assert "'Silverline Partners' is not an OMS counterparty" in error["message"]
    assert "Nearest OMS counterparty: 'Silverline'" in error["hint"]


def test_left_agent_unknown_without_a_close_match_lists_the_counterparties(security_master):
    fields = clean_loan_fields()
    fields["left_agent"] = "Goldfinch Bank"
    error = only(validate(fields, FIELD_LABELS, security_master), "LEFT_AGENT_UNKNOWN")[0]
    assert "No close match" in error["hint"]
    assert "Harbor Point, Ashgrove, Kestrel" in error["hint"]


def test_left_agent_blank_is_not_checked(security_master):
    fields = clean_loan_fields()
    fields["left_agent"] = ""
    assert "LEFT_AGENT_UNKNOWN" not in codes(validate(fields, FIELD_LABELS, security_master))


def test_project_finance_requires_first_lien(security_master):
    fields = clean_loan_fields()
    fields["uop"] = "Project Finance"
    fields["secured_level"] = "Senior Secured"
    error = only(validate(fields, FIELD_LABELS, security_master), "PROJECT_FINANCE_LIEN")[0]
    assert error["field"] == "secured_level"
    assert "found 'Senior Secured'" in error["message"]
    fields["secured_level"] = "First Lien"
    assert validate(fields, FIELD_LABELS, security_master) == []


@pytest.mark.parametrize(
    "name", ["Northwind add-on TLB", "Lakeside incremental TLB", "Northwind Add-On TLB"]
)
def test_addon_new_money_must_equal_issue_size(security_master, name):
    fields = clean_loan_fields()
    fields["opportunity_name"] = name
    fields["issue_size_mm"] = "500.000"
    fields["new_money_mm"] = ""
    error = only(validate(fields, FIELD_LABELS, security_master), "ADDON_NEW_MONEY")[0]
    assert error["field"] == "new_money_mm"
    assert "is blank" in error["message"]
    fields["new_money_mm"] = "250.000"
    error = only(validate(fields, FIELD_LABELS, security_master), "ADDON_NEW_MONEY")[0]
    assert "'250.000'" in error["message"]
    fields["new_money_mm"] = "500.000"
    assert validate(fields, FIELD_LABELS, security_master) == []


def test_bond_fixed_checks_coupon_type_and_floor(security_master):
    fields = clean_bond_fields()
    fields["fixed_floating"] = "Floating"
    fields["floor_talk"] = "0.000%"
    errors = only(validate(fields, FIELD_LABELS, security_master), "BOND_FIXED")
    assert {e["field"] for e in errors} == {"fixed_floating", "floor_talk"}
    loan = clean_loan_fields()
    assert "BOND_FIXED" not in codes(validate(loan, FIELD_LABELS, security_master))


def test_ig_flag_follows_the_sp_issue_rating(security_master):
    fields = clean_loan_fields()
    fields["sp_issue_rating"] = "BBB-"
    fields["moodys_issue_rating"] = "Ba1"  # split rating: S&P decides
    fields["is_investment_grade"] = ""
    error = only(validate(fields, FIELD_LABELS, security_master), "IG_FLAG")[0]
    assert error["field"] == "is_investment_grade"
    assert "BBB-" in error["message"]
    fields["is_investment_grade"] = "No"
    assert "IG_FLAG" in codes(validate(fields, FIELD_LABELS, security_master))
    fields["is_investment_grade"] = "Yes"
    assert validate(fields, FIELD_LABELS, security_master) == []
    fields["sp_issue_rating"] = "BB+"
    fields["is_investment_grade"] = ""
    assert "IG_FLAG" not in codes(validate(fields, FIELD_LABELS, security_master))


def test_demo_rejection_reports_both_gaps(security_master):
    """Design section 12 step 2: the Copperfield deal fails on covenant status AND left agent."""
    fields = clean_loan_fields()
    fields["covenant_status_num"] = ""
    fields["left_agent"] = "Silverline Partners"
    errors = validate(fields, FIELD_LABELS, security_master)
    assert codes(errors) == ["COVENANT_STATUS_REQUIRED", "LEFT_AGENT_UNKNOWN"]
    assert all(set(e) == {"code", "field", "message", "hint"} for e in errors)
