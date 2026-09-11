"""OMS staging-CSV schema: field definitions, value validation and CSV serialization.

The schema itself is ``oms_fields.json`` next to this module. The frontend carries a byte-for-byte
mirror (``chatbot-app/frontend/src/lib/pipeline/omsFields.json``) and a TypeScript port of these
helpers (``omsSchema.ts``); a test asserts the JSON copies match and the CSV/validation behaviour
here is kept identical to the TypeScript so the BFF's regenerated CSV (after an edit) and the
Lambda's CSV (after a parse) are the same bytes for the same fields.

Formats by ``type`` are listed in ``docs/deal-pipeline-design.md`` section 5.
"""

import csv
import io
import json
import re
from pathlib import Path

_SCHEMA_PATH = Path(__file__).with_name("oms_fields.json")

SCHEMA: dict = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
SECTIONS: list[str] = list(SCHEMA["sections"])
FIELDS: list[dict] = list(SCHEMA["fields"])
FIELD_KEYS: list[str] = [f["key"] for f in FIELDS]
FIELD_LABELS: list[str] = [f["label"] for f in FIELDS]

_BY_KEY: dict[str, dict] = {f["key"]: f for f in FIELDS}
_KEY_BY_LABEL: dict[str, str] = {f["label"]: f["key"] for f in FIELDS}

# Keep identical to FORMAT_PATTERNS in chatbot-app/frontend/src/lib/pipeline/omsSchema.ts.
FORMAT_PATTERNS: dict[str, re.Pattern] = {
    "date": re.compile(r"^(1[0-2]|[1-9])/(3[01]|[12][0-9]|[1-9])/\d{4}$"),
    "time": re.compile(r"^(1[0-2]|[1-9])(:[0-5]\d)?(AM|PM)$"),
    "percent": re.compile(r"^-?\d+\.\d{3}%$"),
    "mm": re.compile(r"^\d+\.\d{3}$"),
    "price": re.compile(r"^\d+\.\d{3}$"),
    "integer": re.compile(r"^\d+$"),
    "boolean": re.compile(r"^(Yes|No)$"),
}


def by_key(key: str) -> dict | None:
    """Return the field definition for ``key``, or None when the schema has no such field."""
    return _BY_KEY.get(key)


def key_for_label(label: str) -> str | None:
    """Return the field key whose CSV column label is ``label``, or None for an unknown label."""
    return _KEY_BY_LABEL.get(label)


def fields_by_section() -> list[tuple[str, list[dict]]]:
    """Group the fields by section, sections in schema order, fields in schema order."""
    return [(s, [f for f in FIELDS if f["section"] == s]) for s in SECTIONS]


def format_hint(field_type: str) -> str:
    """Human-readable description of the format a ``type`` expects (matches the TS ``formatHint``)."""
    return {
        "date": "M/D/YYYY",
        "time": "h[:mm]AM|PM, e.g. 12PM",
        "percent": "0.000%",
        "mm": "millions with 3 decimals, e.g. 500.000",
        "price": "3 decimals, e.g. 99.500",
        "integer": "a whole number",
        "boolean": "Yes or No",
    }.get(field_type, "text")


def validate_value(field: dict, raw) -> str | None:
    """Validate one value against its field definition.

    Messages are deliberately the same short phrases the TypeScript ``validateFieldValue`` emits,
    so a problem shown in the review UI and a problem the agent sees read the same.

    :param field: a schema field definition (see :func:`by_key`).
    :param raw: the candidate value; None and non-strings are coerced to text first.
    :returns: None when valid, otherwise a short human-readable problem.
    """
    value = ("" if raw is None else str(raw)).strip()
    if value == "":
        return "required" if field.get("required") else None
    ftype = field["type"]
    if ftype == "enum":
        values = field.get("values") or []
        return None if value in values else f"must be one of {', '.join(values)}"
    if ftype == "string":
        max_length = field.get("max_length")
        if max_length and len(value) > max_length:
            return f"longer than {max_length} characters"
        pattern = field.get("pattern")
        if pattern and not re.search(pattern, value):
            return f"must match {pattern}"
        return None
    if ftype == "integer":
        if not FORMAT_PATTERNS["integer"].match(value):
            return "must be a whole number"
        n = int(value)
        if field.get("min") is not None and n < field["min"]:
            return f"must be ≥ {field['min']}"
        if field.get("max") is not None and n > field["max"]:
            return f"must be ≤ {field['max']}"
        return None
    pattern = FORMAT_PATTERNS.get(ftype)
    if pattern and not pattern.match(value):
        return f"expected {format_hint(ftype)}"
    return None


def empty_fields() -> dict[str, str]:
    """Every key present, blanks as "", schema defaults applied."""
    return {f["key"]: f.get("default", "") for f in FIELDS}


def normalize_fields(values: dict | None) -> dict[str, str]:
    """Fill missing keys with defaults/blanks, stringify values and drop unknown keys.

    Mirrors the TS ``normalizeFields``: an explicit "" in the input overrides a schema default,
    because the caller (an editor, or the model) said the field is blank. Use
    :func:`apply_defaults` afterwards when blanks should fall back to the defaults.

    :param values: partial mapping of field key to value; None means "nothing".
    :returns: a complete field mapping in schema key order.
    """
    out = empty_fields()
    for key, value in (values or {}).items():
        if key in _BY_KEY:
            out[key] = "" if value is None else str(value)
    return out


def apply_defaults(fields: dict[str, str]) -> dict[str, str]:
    """Return a copy of ``fields`` with schema defaults filled into blank values."""
    out = dict(fields)
    for f in FIELDS:
        if "default" in f and not (out.get(f["key"]) or "").strip():
            out[f["key"]] = f["default"]
    return out


def validate_fields(fields: dict[str, str]) -> dict[str, str]:
    """All problems across a record keyed by field key; empty when the record is clean."""
    problems = {}
    for f in FIELDS:
        problem = validate_value(f, fields.get(f["key"], ""))
        if problem:
            problems[f["key"]] = problem
    return problems


_NEEDS_QUOTING = re.compile(r'[",\r\n]')


def _csv_cell(value) -> str:
    """RFC 4180 quoting exactly as the TS ``csvCell``: quote only when the cell needs it."""
    s = "" if value is None else str(value)
    if _NEEDS_QUOTING.search(s):
        return '"' + s.replace('"', '""') + '"'
    return s


def to_csv(fields: dict[str, str]) -> str:
    """Header row of labels plus one data row, "\\n" line endings, RFC 4180 quoting.

    Byte-identical to the TypeScript ``toCsv`` for the same field values, which is what lets the
    BFF regenerate a deal's CSV after an edit without the two sides drifting.
    """
    header = ",".join(_csv_cell(f["label"]) for f in FIELDS)
    row = ",".join(_csv_cell(fields.get(f["key"], "")) for f in FIELDS)
    return f"{header}\n{row}\n"


def parse_csv(text: str) -> tuple[list[str], dict[str, str]]:
    """Read a one-record staging CSV back into ``(header_labels, fields_by_key)``.

    The header is returned verbatim so the OMS validator can report exactly how it differs from
    the schema (``HEADER_MISMATCH``); values are keyed by field key for every header label the
    schema knows, so a misordered file still yields values to validate. Only structural
    problems raise here — a file the OMS could not even read as "one header row, one data row".

    :param text: the CSV text.
    :returns: the header labels in file order, and the known values keyed by field key.
    :raises ValueError: when the file has no header row, no data row, or the data row's cell
        count differs from the header's.
    """
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    if len(rows) < 2:
        raise ValueError("CSV must contain a header row and one data row")
    labels, data = rows[0], rows[1]
    if len(data) != len(labels):
        raise ValueError(f"data row has {len(data)} cells but the header has {len(labels)}")
    fields = {}
    for label, value in zip(labels, data):
        key = _KEY_BY_LABEL.get(label)
        if key is not None:
            fields[key] = value
    return labels, fields
