"""Mock OMS import validation: the rule set of ``docs/deal-pipeline-design.md`` section 6.

Each failure carries a stable ``code`` (what the assistant reasons about), the offending ``field``
key (None for file-level problems), a ``message`` phrased the way an order management system
reports import errors, and a ``hint`` written the way that system's documentation would explain
the rule -- the hint is what gives the assistant something to reason from when it proposes a skill
update or a memory. Several rules are deliberately NOT covered by the initial parsing skill so the
learning loop has something to learn (``COVENANT_STATUS_REQUIRED``, ``LEFT_AGENT_UNKNOWN``,
``PROJECT_FINANCE_LIEN``, ``ADDON_NEW_MONEY``, ``IG_FLAG``).
"""

import re
from decimal import Decimal, InvalidOperation

from backend.deal_pipeline.coerce import ig_from_rating
from backend.deal_pipeline.oms_schema import (
    FIELD_LABELS,
    FIELDS,
    by_key,
    format_hint,
    validate_value,
)

VALIDATOR_VERSION = "2026.09.1"

_AMOUNT_IN_NAME = re.compile(
    r"\d[\d,]*(?:\.\d+)?\s*(?:mm|m|mn|million|bn|b|billion)\b", re.IGNORECASE
)
_CURRENCY_SYMBOL = re.compile(r"[$€£¥]")
_ADDON_WORDS = re.compile(r"add[\s-]?on|incremental", re.IGNORECASE)


def _error(code: str, field: str | None, message: str, hint: str) -> dict:
    return {"code": code, "field": field, "message": message, "hint": hint}


def _label(key: str) -> str:
    return by_key(key)["label"]


def _header_errors(labels: list[str]) -> list[dict]:
    if list(labels) == FIELD_LABELS:
        return []
    if len(labels) != len(FIELD_LABELS):
        detail = f"expected {len(FIELD_LABELS)} columns, found {len(labels)}"
    else:
        position = next(i for i, (a, b) in enumerate(zip(labels, FIELD_LABELS)) if a != b)
        detail = (
            f"column {position + 1} is '{labels[position]}', expected '{FIELD_LABELS[position]}'"
        )
    return [
        _error(
            "HEADER_MISMATCH",
            None,
            f"Header row does not match the pipeline import template: {detail}.",
            "The import template's header must list every pipeline field label in the published "
            "order; download the template from the OMS rather than hand-editing the header.",
        )
    ]


def _field_errors(fields: dict[str, str]) -> list[dict]:
    errors = []
    for f in FIELDS:
        key, label = f["key"], f["label"]
        value = (fields.get(key) or "").strip()
        problem = validate_value(f, value)
        if problem is None:
            continue
        if problem == "required":
            errors.append(
                _error(
                    "REQUIRED_MISSING",
                    key,
                    f"'{label}' is required for a pipeline insert but is blank.",
                    f"'{label}' is part of the minimum insert set. {f.get('notes') or ''}".strip(),
                )
            )
        elif f["type"] == "enum":
            errors.append(
                _error(
                    "ENUM_INVALID",
                    key,
                    f"'{label}' value '{value}' is not an allowed value.",
                    f"Allowed values for '{label}': {', '.join(f.get('values') or [])}.",
                )
            )
        elif key == "opportunity_name":
            # Length problems on the name are reported under the name rule, with the other name
            # checks, so the assistant sees one rule for the field rather than two.
            continue
        else:
            expected = f"must match {f['pattern']}" if f.get("pattern") else format_hint(f["type"])
            errors.append(
                _error(
                    "FORMAT_INVALID",
                    key,
                    f"'{label}' value '{value}' is not valid: {problem}.",
                    f"'{label}' expects {expected}. {f.get('notes') or ''}".strip(),
                )
            )
    return errors


def _opportunity_name_error(fields: dict[str, str]) -> dict | None:
    name = (fields.get("opportunity_name") or "").strip()
    if not name:
        return None
    field = by_key("opportunity_name")
    if len(name) > field["max_length"]:
        reason = f"is {len(name)} characters; the limit is {field['max_length']}"
    elif _CURRENCY_SYMBOL.search(name):
        reason = "contains a currency symbol"
    elif _AMOUNT_IN_NAME.search(name):
        reason = "contains a deal amount"
    else:
        return None
    return _error(
        "OPP_NAME_INVALID",
        "opportunity_name",
        f"'Opportunity Name' '{name}' {reason}.",
        "Opportunity Name is the issuer short name plus the deal type (e.g. 'Northwind add-on "
        "TLB'): at most 60 characters, no currency symbols and no amounts -- size lives in "
        "Issue Size (MM).",
    )


def _record_type(fields: dict[str, str]) -> str:
    """Loan or Bond, from Pipeline Type with Security Type as the fallback."""
    return (fields.get("pipeline_type") or fields.get("security_type") or "").strip()


def _covenant_error(fields: dict[str, str]) -> dict | None:
    if _record_type(fields) != "Loan" or (fields.get("covenant_status_num") or "").strip():
        return None
    return _error(
        "COVENANT_STATUS_REQUIRED",
        "covenant_status_num",
        "Loan records require 'Covenant Status #' (1-4); the field is blank.",
        "Every Loan insert carries a covenant status: 1 = maintenance covenants, 2 = incurrence "
        "only, 3 = cov-lite, 4 = unknown / TBD. A notice stating 'cov-lite' or 'no financial "
        "covenants' is status 3; when the notice is silent use 4.",
    )


def _left_agent_error(fields: dict[str, str], counterparties) -> dict | None:
    name = (fields.get("left_agent") or "").strip()
    if not name:
        return None
    canonical, suggestion = counterparties.canonical_counterparty(name)
    if canonical:
        return None
    if suggestion:
        hint = (
            f"'Left Agent' must be the OMS canonical counterparty name, not the name as written in "
            f"the notice. Nearest OMS counterparty: '{suggestion}'."
        )
    else:
        names = ", ".join(counterparties.canonical_names())
        hint = (
            "'Left Agent' must be the OMS canonical counterparty name. No close match was found; "
            f"the OMS counterparties are: {names}."
        )
    return _error(
        "LEFT_AGENT_UNKNOWN",
        "left_agent",
        f"'Left Agent' value '{name}' is not an OMS counterparty.",
        hint,
    )


def _project_finance_error(fields: dict[str, str]) -> dict | None:
    if (fields.get("uop") or "").strip() != "Project Finance":
        return None
    level = (fields.get("secured_level") or "").strip()
    if level == "First Lien":
        return None
    return _error(
        "PROJECT_FINANCE_LIEN",
        "secured_level",
        f"UOP 'Project Finance' requires 'Secured Level' = 'First Lien'; found '{level}'.",
        "Project-finance term loans are booked as First Lien in the OMS regardless of how the "
        "notice labels the facility.",
    )


def _decimal(text: str) -> Decimal | None:
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError, TypeError):
        return None


def _addon_error(fields: dict[str, str]) -> dict | None:
    if not _ADDON_WORDS.search(fields.get("opportunity_name") or ""):
        return None
    issue, new_money = (
        (fields.get("issue_size_mm") or "").strip(),
        (fields.get("new_money_mm") or "").strip(),
    )
    if new_money and _decimal(new_money) is not None and _decimal(new_money) == _decimal(issue):
        return None
    found = "blank" if not new_money else f"'{new_money}'"
    return _error(
        "ADDON_NEW_MONEY",
        "new_money_mm",
        f"Add-on / incremental records require 'New Money (MM)' equal to 'Issue Size (MM)'; "
        f"'New Money (MM)' is {found} and 'Issue Size (MM)' is '{issue}'.",
        "For an add-on or incremental facility the whole tranche is new money: set New Money (MM) "
        "to the same value as Issue Size (MM).",
    )


def _bond_errors(fields: dict[str, str]) -> list[dict]:
    if _record_type(fields) != "Bond":
        return []
    errors = []
    fixed_floating = (fields.get("fixed_floating") or "").strip()
    if fixed_floating != "Fixed":
        errors.append(
            _error(
                "BOND_FIXED",
                "fixed_floating",
                f"Bond records must have 'Fixed/Floating' = 'Fixed'; found '{fixed_floating}'.",
                "Notes and bonds carry a fixed coupon in the pipeline; Floating is for loans.",
            )
        )
    floor_talk = (fields.get("floor_talk") or "").strip()
    if floor_talk:
        errors.append(
            _error(
                "BOND_FIXED",
                "floor_talk",
                f"Bond records must leave 'Floor Talk' blank; found '{floor_talk}'.",
                "Floor talk applies to floating-rate loans only; a bond coupon has no floor.",
            )
        )
    return errors


def _ig_flag_error(fields: dict[str, str]) -> dict | None:
    sp = (fields.get("sp_issue_rating") or "").strip()
    if ig_from_rating(sp, None) != "Yes":
        return None
    flag = (fields.get("is_investment_grade") or "").strip()
    if flag == "Yes":
        return None
    return _error(
        "IG_FLAG",
        "is_investment_grade",
        f"'Is Investment Grade?' must be 'Yes' when the S&P issue rating is BBB- or better; "
        f"found '{flag}' with S&P issue rating '{sp}'.",
        "The OMS derives investment-grade eligibility from the S&P issue rating alone: BBB- and "
        "above is investment grade even when another agency rates the issue below Baa3.",
    )


def validate(fields: dict[str, str], labels: list[str], counterparties) -> list[dict]:
    """Validate one staging record and return every import error the mock OMS would report.

    :param fields: values keyed by field key (as returned by ``oms_schema.parse_csv``).
    :param labels: the CSV header labels in file order.
    :param counterparties: an object exposing ``canonical_counterparty(name)`` and
        ``canonical_names()`` -- normally a :class:`security_master.SecurityMaster`.
    :returns: ``UploadError`` dicts ``{code, field, message, hint}``; empty when accepted.
    """
    errors = _header_errors(labels) + _field_errors(fields)
    for check in (
        _opportunity_name_error,
        _covenant_error,
        _project_finance_error,
        _addon_error,
        _ig_flag_error,
    ):
        error = check(fields)
        if error:
            errors.append(error)
    left_agent = _left_agent_error(fields, counterparties)
    if left_agent:
        errors.append(left_agent)
    errors.extend(_bond_errors(fields))
    return errors
