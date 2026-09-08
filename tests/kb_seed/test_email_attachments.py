"""Validation for the binary email attachments in the knowledge-base seed corpus.

The ``.pdf`` and ``.xlsx`` files under ``data/kb-seed/retrieved_emails/`` are committed BUILD
PRODUCTS. ``scripts/generate_kb_email_attachments.py`` holds their content as Python literals and
is the reviewable source of truth; the binaries are committed because Terraform uploads them to S3
and because regenerating them at deploy time would need a toolchain the deploy path does not have.

That arrangement has two distinct failure modes, and this module covers both:

1. **Stale.** Someone edits a content literal and forgets to re-run the generator, so the file in
   git no longer matches the script that supposedly produced it. Review then approves content that
   was never ingested. ``test_committed_attachments_match_the_generator`` is the ``--check`` gate.

2. **Invalid.** The generator writes both formats by hand — the PDF from raw objects and a
   byte-offset xref table, the XLSX through a normalized zip. Both are easy to break in ways that
   still produce *stable* bytes, and a determinism check alone will happily confirm two identically
   broken runs. This actually happened: a bad regex backreference corrupted ``docProps/core.xml``
   and ``--check`` passed, because both runs corrupted it the same way. So these tests parse the
   files rather than merely comparing them.

Bedrock ingestion is the real consumer, and a file it cannot parse is skipped with no error
surfaced anywhere — the document simply never appears in retrieval results.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from openpyxl import load_workbook

REPO_ROOT = Path(__file__).resolve().parents[2]
EMAIL_DIR = REPO_ROOT / "data" / "kb-seed" / "retrieved_emails"
GENERATOR = REPO_ROOT / "scripts" / "generate_kb_email_attachments.py"

PDFS = sorted(EMAIL_DIR.glob("*.pdf"))
XLSXS = sorted(EMAIL_DIR.glob("*.xlsx"))

# The zip timestamp the generator pins every member to (1980-01-01, the DOS epoch and the
# earliest a zip can represent). Any other value means a real clock leaked into the output.
FIXED_ZIP_DATE_TIME = (1980, 1, 1, 0, 0, 0)

# Text each PDF must contain. The generator writes uncompressed content streams, so these are
# greppable in the raw bytes — which is also exactly why Bedrock can extract them. Chosen as the
# identifiers an agent would actually filter or reason on, not decorative prose.
#
# Both PDFs are copies of loan notices from `data/input/`, so every string below is also present in
# the corresponding sample — which is the property that makes a KB precedent reasonable about a
# document IDP has ground truth for. If one of these has to change, check the sample first.
EXPECTED_PDF_TEXT = {
    # data/input/03-paydown-principal-notices/Paydown Notice - Unmapped Facility.pdf
    "20260226-paydown-notice-unmapped-facility.pdf": [
        "SL-99001",
        "WIRE-20260302-EVG",
        "CINDERMOOR LOGISTICS TL-B $250MM",
        "EVERGREEN SPECIALTY FINANCE INC.",
        "12,500.00",
        # The novation is the corpus's reason for the absent LoanX ID; without this line the
        # document no longer explains why it is a missing_reference precedent at all.
        "novated from a predecessor agent on 14-Jan-2026",
    ],
    # data/input/05-multi-facility-aggregated-wire/
    #     One Wire for Multiple Facilities - Consolidated Payment Advice.pdf
    "20260227-consolidated-payment-advice-cindermoor.pdf": [
        "CINDERMOOR LOGISTICS HOLDINGS, INC.",
        "Tidelantern Senior Loan Fund, LP",
        "02-Mar-2026",
        "26,322.73",
        # The three components the aggregate has to be split into.
        "4,182.55",
        "9,640.18",
        # As printed, un-truncated: the eight-character rule is what the covering email teaches.
        "LX223061XXXX1",
    ],
}

# sheet title -> (dimensions, the column that must sum to its TOTAL row)
EXPECTED_SHEETS = {
    "20260227-facility-allocation-cindermoor.xlsx": {
        "title": "Cindermoor Wire Allocation",
        "dimensions": "A1:G5",
        "total_columns": ["Amount USD"],
    },
    "20260718-fx-revaluation-detail-JUN26.xlsx": {
        "title": "FX Reval Jun-2026",
        "dimensions": "A1:H6",
        "total_columns": ["Custodian USD", "Ledger USD", "Difference USD"],
    },
}


def test_the_expected_attachments_are_present() -> None:
    """Guard every parametrized test below against silently collapsing to zero cases."""
    assert [path.name for path in PDFS] == sorted(EXPECTED_PDF_TEXT)
    assert [path.name for path in XLSXS] == sorted(EXPECTED_SHEETS)


def test_committed_attachments_match_the_generator() -> None:
    """The committed binaries must still carry what the current generator declares.

    Equivalent to ``python3 scripts/generate_kb_email_attachments.py --check``, run as a test so
    CI catches an edited literal that was never regenerated.

    This matters beyond provenance: Terraform tracks each seed object with ``filemd5()``, so a
    committed file that drifts re-uploads, which changes the S3 etag, which retriggers the
    ingestion job for the entire corpus.

    PDFs are compared byte-for-byte; workbooks by content. Asserting byte-identity on the
    workbooks is NOT possible and was tried: openpyxl serializes XML through ``lxml`` when it is
    importable and the stdlib ``ElementTree`` otherwise, and the two emit different bytes for the
    same tree, so the check passed locally (lxml present transitively) and failed on
    ``python:3.12-slim`` (no lxml) in MR !7's pipeline. Adding lxml to ``requirements-dev.txt``
    would only move the dependency from "is it installed" to "which version", so the generator
    compares declared content instead — see ``_normalize_zip`` and ``_xlsx_matches`` there.
    """
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0, (
        f"generator --check failed:\n{result.stdout}\n{result.stderr}\n"
        "re-run: python3 scripts/generate_kb_email_attachments.py"
    )


@pytest.mark.parametrize("pdf", PDFS, ids=lambda path: path.name)
def test_pdf_has_a_valid_header_and_trailer(pdf: Path) -> None:
    """A parser identifies a PDF by its header and locates content from the trailer.

    :param pdf: path to the PDF attachment.
    """
    raw = pdf.read_bytes()
    assert raw.startswith(b"%PDF-1."), f"{pdf.name} does not start with a %PDF-1.x header"
    assert raw.rstrip().endswith(b"%%EOF"), f"{pdf.name} does not end with %%EOF"
    assert raw.count(b"startxref") == 1, f"{pdf.name} has {raw.count(b'startxref')} startxrefs"
    assert b"/Type /Catalog" in raw, f"{pdf.name} has no document catalog"


@pytest.mark.parametrize("pdf", PDFS, ids=lambda path: path.name)
def test_pdf_xref_offsets_point_at_real_objects(pdf: Path) -> None:
    """Every xref entry must be a byte offset landing exactly on its object header.

    This is the generator's most fragile computation and the one most likely to break silently:
    the offsets are absolute positions accumulated while serializing, so inserting a single byte
    anywhere above an object shifts every offset below it. A reader that follows a stale offset
    lands mid-object and treats the file as damaged — and because the text is uncompressed, a
    naive grep for the expected content would still succeed, so nothing else here would notice.

    :param pdf: path to the PDF attachment.
    """
    raw = pdf.read_bytes()

    startxref = int(re.search(rb"startxref\s+(\d+)", raw).group(1))
    assert raw[startxref : startxref + 4] == b"xref", (
        f"{pdf.name}: startxref points at {raw[startxref : startxref + 20]!r}, not the xref table"
    )

    table = raw[startxref:]
    count = int(re.match(rb"xref\s+0\s+(\d+)", table).group(1))
    entries = re.findall(rb"(\d{10}) (\d{5}) ([nf])", table)
    assert len(entries) == count, f"{pdf.name}: header says {count} entries, found {len(entries)}"

    # Entry 0 is the mandatory free head of the linked list; objects start at 1.
    assert entries[0][2] == b"f", f"{pdf.name}: entry 0 must be free"
    for number, (offset, _generation, kind) in enumerate(entries[1:], start=1):
        assert kind == b"n", f"{pdf.name}: object {number} is marked free"
        position = int(offset)
        expected = f"{number} 0 obj".encode("ascii")
        assert raw[position : position + len(expected)] == expected, (
            f"{pdf.name}: xref says object {number} is at byte {position}, but that offset holds "
            f"{raw[position : position + len(expected)]!r}"
        )


@pytest.mark.parametrize("pdf", PDFS, ids=lambda path: path.name)
def test_pdf_text_is_extractable_and_correct(pdf: Path) -> None:
    """The identifiers Bedrock must index have to be present as literal, unfiltered text.

    The generator writes content streams with no ``/Filter``, so the page text sits in the file
    verbatim. That is deliberate: it keeps the writer dependency-free and makes the output
    greppable, so this assertion needs no PDF parser.

    A compression filter or a mangled text-showing operator would break extraction, and the
    document would ingest as an empty page — indexed, retrievable, and useless.

    :param pdf: path to the PDF attachment.
    """
    raw = pdf.read_bytes()
    assert b"/Filter" not in raw, (
        f"{pdf.name} declares a filter; the text is no longer extractable without decoding"
    )
    missing = [text for text in EXPECTED_PDF_TEXT[pdf.name] if text.encode("ascii") not in raw]
    assert not missing, f"{pdf.name} is missing expected text: {missing}"


@pytest.mark.parametrize("pdf", PDFS, ids=lambda path: path.name)
def test_pdf_is_within_the_bedrock_file_size_limit(pdf: Path) -> None:
    """Bedrock rejects a source file over 50 MB. These are kilobytes, so this is a canary.

    A runaway page loop or an accidentally embedded font would show up here first.

    :param pdf: path to the PDF attachment.
    """
    assert pdf.stat().st_size < 50 * 1024 * 1024
    assert pdf.stat().st_size < 100 * 1024, (
        f"{pdf.name} is {pdf.stat().st_size} bytes — far larger than a few pages of text should be"
    )


@pytest.mark.parametrize("workbook_path", XLSXS, ids=lambda path: path.name)
def test_xlsx_opens_and_has_the_expected_sheet(workbook_path: Path) -> None:
    """The workbook must actually load, with the sheet named and sized as expected.

    Loading is the assertion that matters. A hand-normalized zip can be byte-stable and still
    invalid — pinning timestamps once corrupted ``docProps/core.xml`` in a way that only surfaced
    when a parser tried to read the XML.

    :param workbook_path: path to the spreadsheet attachment.
    """
    expected = EXPECTED_SHEETS[workbook_path.name]
    workbook = load_workbook(workbook_path)
    assert workbook.sheetnames == [expected["title"]], (
        f"{workbook_path.name} has sheets {workbook.sheetnames}"
    )
    assert workbook[expected["title"]].dimensions == expected["dimensions"]


@pytest.mark.parametrize("workbook_path", XLSXS, ids=lambda path: path.name)
def test_xlsx_amounts_are_numbers_not_text(workbook_path: Path) -> None:
    """Amount cells must be numeric, or the corpus teaches the wrong thing about its own data.

    A number written as a string still *renders* correctly, so this is invisible on inspection.
    It matters because these sheets are the worked examples behind an agent that reconciles
    amounts: the totals below cannot be verified to tie if the cells are text, and the extracted
    text would carry stray quoting into whatever the agent quotes back.

    :param workbook_path: path to the spreadsheet attachment.
    """
    sheet = load_workbook(workbook_path)[EXPECTED_SHEETS[workbook_path.name]["title"]]
    header = [cell.value for cell in sheet[1]]
    for column_name in EXPECTED_SHEETS[workbook_path.name]["total_columns"]:
        index = header.index(column_name)
        for row in sheet.iter_rows(min_row=2):
            value = row[index].value
            assert isinstance(value, (int, float)), (
                f"{workbook_path.name}::{column_name} row {row[0].row} holds {value!r} "
                f"({type(value).__name__}), not a number"
            )


@pytest.mark.parametrize("workbook_path", XLSXS, ids=lambda path: path.name)
def test_xlsx_totals_tie_to_their_columns(workbook_path: Path) -> None:
    """Every TOTAL row must equal the sum of the rows above it.

    These are reconciliation fixtures, so their internal arithmetic is not cosmetic — the corpus
    is retrieved as worked precedent for how a break was explained, and an agent that reasons
    from a schedule whose total does not tie will reproduce the error or, worse, "discover" a
    discrepancy that only exists in the fixture.

    This test earned its place immediately: it caught the FX sheet's Ledger USD total reading
    7,099,277.30 against a column summing to 7,099,276.90 — a 0.40 error that also contradicted
    the sheet's own Difference total of 135.60.

    :param workbook_path: path to the spreadsheet attachment.
    """
    sheet = load_workbook(workbook_path)[EXPECTED_SHEETS[workbook_path.name]["title"]]
    header = [cell.value for cell in sheet[1]]
    rows = list(sheet.iter_rows(min_row=2, values_only=True))

    total_row = rows[-1]
    assert total_row[0] == "TOTAL", f"{workbook_path.name}'s last row is {total_row[0]!r}"

    for column_name in EXPECTED_SHEETS[workbook_path.name]["total_columns"]:
        index = header.index(column_name)
        components = sum(row[index] for row in rows[:-1])
        # Cent-level tolerance: these are floats, and the literals are written to 2 decimals.
        assert abs(components - total_row[index]) < 0.005, (
            f"{workbook_path.name}::{column_name} rows sum to {components:.2f} but TOTAL says "
            f"{total_row[index]:.2f}"
        )


def test_fx_differences_reconcile_the_two_valuation_columns() -> None:
    """The FX sheet's Difference column must be Custodian minus Ledger, row by row.

    The whole point of this attachment is to show a tolerance-class break: four trades whose two
    valuations differ by cents. If the Difference column does not derive from the two columns
    beside it, the fixture demonstrates nothing, and the agent's guidance on tolerance thresholds
    is anchored to numbers that do not describe the data.
    """
    name = "20260718-fx-revaluation-detail-JUN26.xlsx"
    sheet = load_workbook(EMAIL_DIR / name)[EXPECTED_SHEETS[name]["title"]]
    header = [cell.value for cell in sheet[1]]
    custodian, ledger, difference = (
        header.index(column) for column in ("Custodian USD", "Ledger USD", "Difference USD")
    )

    for row in sheet.iter_rows(min_row=2, values_only=True):
        expected = row[custodian] - row[ledger]
        assert abs(expected - row[difference]) < 0.005, (
            f"{name}: {row[0]} shows a difference of {row[difference]:.2f}, but "
            f"{row[custodian]:.2f} - {row[ledger]:.2f} = {expected:.2f}"
        )


@pytest.mark.parametrize("workbook_path", XLSXS, ids=lambda path: path.name)
def test_xlsx_zip_members_carry_no_wall_clock_timestamp(workbook_path: Path) -> None:
    """A live timestamp anywhere in the zip makes the build product non-reproducible.

    An ``.xlsx`` is a zip, and both the member headers and ``docProps/core.xml`` normally record
    the moment of writing. Either one re-stamped per run changes the file's bytes with no content
    change, and Terraform's ``filemd5()`` then re-uploads it and re-ingests the corpus.

    ``--check`` above would also catch this, but only when run twice in different processes —
    within one process openpyxl's stamp is cached and identical. This asserts the property
    directly.

    :param workbook_path: path to the spreadsheet attachment.
    """
    with zipfile.ZipFile(io.BytesIO(workbook_path.read_bytes())) as archive:
        for info in archive.infolist():
            assert info.date_time == FIXED_ZIP_DATE_TIME, (
                f"{workbook_path.name}::{info.filename} is stamped {info.date_time}, "
                f"not the pinned {FIXED_ZIP_DATE_TIME}"
            )

        core = archive.read("docProps/core.xml").decode("utf-8")

    stamps = re.findall(r"<dcterms:(?:created|modified)[^>]*>([^<]*)<", core)
    assert stamps, f"{workbook_path.name}: docProps/core.xml has no dcterms timestamps to check"
    assert set(stamps) == {"2026-01-01T00:00:00Z"}, (
        f"{workbook_path.name}: docProps/core.xml carries unpinned timestamps {sorted(set(stamps))}"
    )


@pytest.mark.parametrize("workbook_path", XLSXS, ids=lambda path: path.name)
def test_xlsx_contains_every_required_opc_part(workbook_path: Path) -> None:
    """A normalized archive must still hold all the parts that make it a readable package.

    The generator rebuilds the zip member by member to pin timestamps, so a part could be dropped
    or renamed in the process. ``[Content_Types].xml`` and ``_rels/.rels`` are what a reader
    resolves everything else through; without them the file is just a zip.

    Note this deliberately does NOT assert that ``[Content_Types].xml`` comes *first*. ECMA-376
    Part 2 asks for that so a package can be consumed as a stream, but openpyxl writes it last and
    every reader in this path resolves parts through the zip central directory instead. Asserting
    the strict-streaming layout would fail on a file that is, in practice, entirely valid.

    :param workbook_path: path to the spreadsheet attachment.
    """
    with zipfile.ZipFile(io.BytesIO(workbook_path.read_bytes())) as archive:
        members = set(archive.namelist())
        # A truncated or mis-declared part fails `testzip`, which decompresses every member and
        # checks its CRC -- cheap here, and it proves the rebuilt archive is internally consistent.
        assert archive.testzip() is None, f"{workbook_path.name} has a corrupt member"

    required = {
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/core.xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/worksheets/sheet1.xml",
    }
    assert required <= members, f"{workbook_path.name} is missing {sorted(required - members)}"
