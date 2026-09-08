"""The Glue schema and the seeded CSV must agree, positionally.

LazySimpleSerDe maps CSV columns by POSITION. A header/schema mismatch does not error — Athena
returns values under the wrong column names, which is far worse than a failure.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSV = ROOT / "data" / "general-ledger" / "gl-entries.csv"
TF = ROOT / "infra" / "modules" / "gl-mock" / "main.tf"

EXPECTED = [
    "entry_id",
    "entry_date",
    "value_date",
    "account",
    "borrower",
    "facility",
    "reference",
    "description",
    "amount",
    "currency",
    "entry_type",
    "fund_code",
    "expected_value_date",
    "loanx_id",
    "cusip",
    "isin",
    # ⚠️ APPEND ONLY, and append to infra/modules/gl-mock/main.tf's `dynamic "columns"` list in the
    # same commit. LazySimpleSerDe maps by POSITION, so a header/schema mismatch does not error —
    # Athena returns values under the wrong column names, which is worse than a failure.
    "activity_type",
]


def test_csv_header_matches_the_expected_column_order() -> None:
    """The header is the positional contract; this pins it."""
    header = CSV.read_text().splitlines()[0].split(",")
    assert header == EXPECTED


def test_glue_schema_matches_the_expected_column_order() -> None:
    """Parse the `dynamic "columns"` list rather than trusting a comment to stay in sync."""
    block = TF.read_text().split('dynamic "columns"')[1].split("content {")[0]
    assert re.findall(r'name = "(\w+)"', block) == EXPECTED


def test_every_row_has_the_full_column_count() -> None:
    """A short row shifts every later column's value without any error from Athena."""
    lines = [line for line in CSV.read_text().splitlines() if line.strip()]
    for number, line in enumerate(lines, start=1):
        assert len(line.split(",")) == len(EXPECTED), f"line {number} has the wrong field count"


def test_at_least_one_row_is_non_usd() -> None:
    """A single-currency seed makes the currency dimension unfalsifiable.

    A candidate is disqualified on incompatible currency where BOTH sides are populated. With every
    row in USD, a currency filter and no filter return the same set, so nothing can demonstrate that
    the rule fires — or that it does not fire on a legitimate EUR match.
    """
    header = CSV.read_text().splitlines()[0].split(",")
    currency = header.index("currency")
    currencies = {
        line.split(",")[currency] for line in CSV.read_text().splitlines()[1:] if line.strip()
    }
    assert len(currencies) > 1, (
        f"every ledger row is {currencies} — the currency dimension is untestable"
    )


def test_activity_type_is_populated_on_every_row() -> None:
    """An empty activity on some rows would make the dimension silently optional.

    The agent is told to match on fund AND date AND activity (AM6). A blank here reads as "this entry
    has no activity", which is never true of a real ledger posting — it means the seed is incomplete.
    """
    header = CSV.read_text().splitlines()[0].split(",")
    index = header.index("activity_type")
    for number, line in enumerate(CSV.read_text().splitlines()[1:], start=2):
        if not line.strip():
            continue
        assert line.split(",")[index].strip(), f"line {number} has no activity_type"


def test_no_reference_is_a_document_filename() -> None:
    """`record-match-review` forbids matching on a filename, so the seed must not offer one.

    Two rows carried `Paydown_and_Interest_Notice.pdf` as their `reference` — an invitation to do the
    exact thing the skill prohibits, in the column the agent is most likely to match on. The filename
    belongs on the notice, as `source_document`.
    """
    header = CSV.read_text().splitlines()[0].split(",")
    index = header.index("reference")
    for number, line in enumerate(CSV.read_text().splitlines()[1:], start=2):
        if not line.strip():
            continue
        reference = line.split(",")[index]
        assert not reference.lower().endswith((".pdf", ".msg", ".eml", ".xlsx")), (
            f"line {number} offers a document filename as a ledger reference: {reference!r}"
        )
