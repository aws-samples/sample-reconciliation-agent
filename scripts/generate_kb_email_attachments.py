#!/usr/bin/env python3
"""Generate the PDF and spreadsheet attachments for ``data/kb-seed/retrieved_emails/``.

The knowledge-base corpus contains synthetic archived correspondence: an HTML email plus the
attachments that arrived with it. HTML is hand-authored (it is reviewable text), but PDF and
XLSX are binary container formats and cannot be. This script is the reviewable source of truth
for them: the *content* lives here as plain Python literals, and the binaries are a build
product that happens to be committed so Terraform can upload them without a build step.

The two PDF literals are **copies of specific notices from the loan-notice input corpus**
(``data/input/``), not inventions — see the ⚠️ note above ``CONSOLIDATED_PAYMENT_ADVICE_PDF`` for
which sample each one is and what may be changed about it. The spreadsheets are the lender's own
working papers, since the notice corpus contains none.

Two properties matter and are enforced below:

**Deterministic output.** Re-running the script must produce byte-identical files, otherwise
every run creates a spurious git diff and — worse — churns the ``filemd5`` etag on every
``aws_s3_object.kb_seed``, which retriggers ``null_resource.kb_ingestion`` and re-ingests the
whole corpus for no reason. Both writers are therefore timestamp-free: the PDF carries no
``/CreationDate`` and the XLSX has its document properties and every zip member timestamp
pinned to a fixed value (openpyxl otherwise stamps ``docProps/core.xml`` and each zip entry
with the current time). This holds per machine; for the XLSX it does *not* hold across machines,
because openpyxl's XML bytes depend on whether ``lxml`` is installed — so ``--check`` compares
workbooks by declared content rather than by bytes. See the ⚠️ note in ``_normalize_zip``.

**Extractable text.** Bedrock has to be able to parse these back into text or they are dead
weight in the index. The PDF writer emits uncompressed ``Tj`` text runs in a standard Type1
font (Helvetica/WinAnsi) — the most widely parseable shape there is — rather than anything
subset-embedded. ``tests/kb_seed/test_email_attachments.py`` asserts the round trip.

Usage::

    python3 scripts/generate_kb_email_attachments.py            # write the files
    python3 scripts/generate_kb_email_attachments.py --check     # verify they are up to date

``--check`` is what CI wants: it fails if the committed binaries do not match what this
script would produce, so the content literals below can never silently drift from the files.
PDFs and HTML are compared byte-for-byte; workbooks by content, for the reason above.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import re
import sys
import zipfile
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

REPO_ROOT = Path(__file__).resolve().parents[1]
EMAIL_DIR = REPO_ROOT / "data" / "kb-seed" / "retrieved_emails"

# Pinned so the output never depends on when the script ran. 1980-01-01 is the earliest
# timestamp the zip format can represent, which is the conventional choice for reproducible
# archives.
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
FIXED_DOC_TIMESTAMP = dt.datetime(2026, 1, 1, 0, 0, 0)

# US Letter, in PostScript points.
PAGE_WIDTH = 612
PAGE_HEIGHT = 792
LEFT_MARGIN = 54
TOP_BASELINE = 738
FONT_SIZE = 9.5
LINE_HEIGHT = 13
# Lines that fit between TOP_BASELINE and a 54pt bottom margin.
LINES_PER_PAGE = int((TOP_BASELINE - 54) / LINE_HEIGHT)


# --------------------------------------------------------------------------------------
# PDF writer
# --------------------------------------------------------------------------------------


def _escape_pdf_text(line: str) -> str:
    """Escape a line of text for inclusion in a PDF literal string.

    Inside a PDF ``(...)`` string, a backslash and both parentheses are structural and must be
    escaped or the content stream becomes unparseable.

    :param line: the raw text line.
    :return: the same text with ``\\``, ``(`` and ``)`` escaped.
    """
    return line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _content_stream(lines: list[str]) -> bytes:
    """Build the uncompressed PDF content stream that renders one page of text lines.

    ``BT``/``ET`` delimit a text object; ``Tf`` selects the font and size; ``Td`` positions the
    first baseline; ``TL`` sets the leading so ``T*`` can advance one line at a time.

    :param lines: the text lines for this page, already known to fit.
    :return: the content stream bytes.
    """
    parts = [f"BT /F1 {FONT_SIZE} Tf {LEFT_MARGIN} {TOP_BASELINE} Td {LINE_HEIGHT} TL".encode()]
    for line in lines:
        # An empty line still needs T* to advance the baseline, but emitting "() Tj" for it is
        # harmless and keeps the stream uniform.
        parts.append(f"({_escape_pdf_text(line)}) Tj T*".encode("ascii"))
    parts.append(b"ET")
    return b"\n".join(parts)


def build_pdf(lines: list[str]) -> bytes:
    """Render text lines into a minimal, deterministic, text-extractable PDF.

    The document is assembled by hand rather than with a PDF library because the repo has no
    such dependency and the requirement is narrow: plain text that a parser can read back.
    Every object is written uncompressed and the cross-reference table offsets are computed
    from the actual byte positions as the file is built.

    Deliberately absent: ``/CreationDate`` and ``/ModDate``. A timestamp would make the output
    non-deterministic, which is the one thing that must not happen (see the module docstring).

    :param lines: the text lines to render; paginated automatically.
    :return: the complete PDF file bytes.
    """
    for line in lines:
        # WinAnsiEncoding covers Latin-1, but restricting to ASCII removes any question about
        # how a given parser maps the high range back to characters.
        if not line.isascii():
            raise ValueError(f"PDF text must be ASCII, got: {line!r}")

    pages = [
        lines[start : start + LINES_PER_PAGE] for start in range(0, len(lines), LINES_PER_PAGE)
    ] or [[]]

    # Object numbering: 1 = catalog, 2 = page tree, 3 = font, then one page object and one
    # content-stream object per page.
    first_page_object = 4
    page_object_ids = [first_page_object + 2 * index for index in range(len(pages))]
    content_object_ids = [object_id + 1 for object_id in page_object_ids]

    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: (
            "<< /Type /Pages /Kids ["
            + " ".join(f"{object_id} 0 R" for object_id in page_object_ids)
            + f"] /Count {len(pages)} >>"
        ).encode("ascii"),
        # Courier rather than Helvetica: the content below aligns its tables with spaces, and
        # a proportional font would render those columns ragged. Both are standard Type1 fonts
        # with no embedding, so parseability is identical — this is purely about the file
        # looking right when a human opens it. Courier at 9.5pt fits ~88 characters per line.
        3: (b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
    }

    for page_lines, page_id, content_id in zip(pages, page_object_ids, content_object_ids):
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        ).encode("ascii")
        stream = _content_stream(page_lines)
        objects[content_id] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode("ascii") + stream + b"\nendstream"
        )

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for object_id in sorted(objects):
        offsets[object_id] = len(out)
        out += f"{object_id} 0 obj\n".encode("ascii") + objects[object_id] + b"\nendobj\n"

    # The xref table must list every object from 0 upward, in order, each entry exactly 20
    # bytes. Object 0 is always the free-list head.
    xref_offset = len(out)
    highest = max(objects)
    out += f"xref\n0 {highest + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for object_id in range(1, highest + 1):
        out += f"{offsets[object_id]:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {highest + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


# --------------------------------------------------------------------------------------
# XLSX writer
# --------------------------------------------------------------------------------------


def _pin_core_properties(core_xml: bytes) -> bytes:
    """Replace every ``dcterms`` timestamp in ``docProps/core.xml`` with the fixed value.

    Setting ``workbook.properties.modified`` is not enough: openpyxl's save path overwrites
    ``dcterms:modified`` with the current UTC time regardless, so the workbook bytes differ on
    every run. Rewriting the serialized XML is the only place the value can actually be pinned.

    :param core_xml: the original ``docProps/core.xml`` bytes.
    :return: the same XML with all ``dcterms:*`` timestamps set to ``FIXED_DOC_TIMESTAMP``.
    """
    stamp = FIXED_DOC_TIMESTAMP.strftime("%Y-%m-%dT%H:%M:%SZ").encode("ascii")
    # Group references must be spelled \g<n>, not \1: the replacement concatenates a timestamp
    # that starts with a digit, and "\1" + "2026..." parses as a reference to group 12.
    return re.sub(
        rb"(<dcterms:(created|modified)\b[^>]*>)[^<]*(</dcterms:\2>)",
        rb"\g<1>" + stamp + rb"\g<3>",
        core_xml,
    )


def _normalize_zip(raw: bytes) -> bytes:
    """Rewrite a zip archive with all timestamps pinned, preserving member order.

    An ``.xlsx`` is a zip, and openpyxl stamps both the zip members and the document
    properties with the current time, so two runs of an otherwise identical workbook differ in
    bytes. Both are pinned here.

    Member *order* is preserved rather than sorted, so that the normalized archive is structurally
    identical to the one openpyxl produced and differs from it only in metadata. openpyxl happens
    to write ``[Content_Types].xml`` last; that is fine for readers that resolve parts through the
    zip central directory (Excel, openpyxl itself, and the Bedrock ingestion path all do), but a
    strictly streaming OPC consumer wants it first, so there is no reordering to be gained here —
    only a working layout to be preserved.

    ⚠️ Pinning the metadata makes the output reproducible on *this* machine, but NOT across
    machines, and no amount of zip-level normalization can fix that. openpyxl serializes its XML
    through ``lxml`` when lxml is importable and through the stdlib ``ElementTree`` when it is not,
    and the two emit the same XML tree as different bytes (namespace declarations, attribute order,
    self-closing tags). So every part — ``xl/styles.xml``, ``xl/workbook.xml``, ``docProps/core.xml``
    — differs by a handful of bytes depending only on whether lxml happens to be installed. That is
    what failed ``--check`` in CI for MR !7: lxml 6.1.1 was present locally (transitively, it is not
    in ``requirements-dev.txt``) and absent from ``python:3.12-slim``. Reproduced locally by blocking
    the lxml import, which gave byte-for-byte the CI member sizes.

    The conclusion is that XLSX byte-identity is not a property worth asserting — openpyxl does not
    promise it. ``tests/kb_seed/test_email_attachments.py`` therefore compares workbooks by
    *content*, and ``--check`` does the same via :func:`_xlsx_matches`. Do not "fix" a future
    mismatch by pinning the compressor: an earlier attempt here switched to ``ZIP_STORED`` on the
    theory that the linked zlib was the variable, which cost 15 KB per workbook and changed nothing,
    because the differing bytes were in the XML, upstream of the compressor.

    :param raw: the original archive bytes.
    :return: an equivalent archive with deterministic metadata.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source:
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as target:
            for member in source.infolist():
                payload = source.read(member.filename)
                if member.filename == "docProps/core.xml":
                    payload = _pin_core_properties(payload)
                info = zipfile.ZipInfo(filename=member.filename, date_time=FIXED_ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = member.external_attr
                target.writestr(info, payload)
    return buffer.getvalue()


def _workbook_content(raw: bytes) -> list[object]:
    """Reduce a workbook to the content this script actually declares.

    Everything :func:`build_xlsx` sets is compared and nothing else, so the result is invariant
    under the XML-serializer difference described in :func:`_normalize_zip` while still changing
    the moment a content literal below is edited: sheet title, every cell value, the header row's
    bold flag, each cell's number format, and the column widths.

    :param raw: the workbook bytes.
    :return: a comparable structure; equality means "same declared content".
    """
    workbook = load_workbook(io.BytesIO(raw))
    sheet = workbook.active
    return [
        sheet.title,
        [[cell.value for cell in row] for row in sheet.iter_rows()],
        [cell.font.bold for cell in sheet[1]],
        [[cell.number_format for cell in row] for row in sheet.iter_rows()],
        [
            sheet.column_dimensions[get_column_letter(index)].width
            for index in range(1, sheet.max_column + 1)
        ],
    ]


def _xlsx_matches(committed: bytes, expected: bytes) -> bool:
    """Report whether a committed workbook still carries the generator's declared content.

    Deliberately NOT a byte comparison — see the ⚠️ note in :func:`_normalize_zip` for why xlsx
    bytes are not reproducible across machines.

    :param committed: bytes currently on disk.
    :param expected: bytes the generator produces now.
    :return: True when the declared content is unchanged.
    """
    return _workbook_content(committed) == _workbook_content(expected)


def _describe_mismatch(committed: bytes, expected: bytes) -> str:
    """Explain *how* two artifact payloads differ, for the ``--check`` failure message.

    Workbooks are reported as a content diff, because that is the level ``--check`` compares them
    at. Everything else gets a length comparison, which is all a PDF byte-diff can usefully say.

    :param committed: bytes currently on disk.
    :param expected: bytes the generator produces now.
    :return: a single indented human-readable line per finding.
    """
    if not (committed[:2] == b"PK" and expected[:2] == b"PK"):
        return f"    bytes differ: {len(committed):,} on disk vs {len(expected):,} generated"

    on_disk, generated = _workbook_content(committed), _workbook_content(expected)
    labels = ["sheet title", "cell values", "header bold", "number formats", "column widths"]
    lines = [
        f"    {label} differ:\n      on disk:   {mine!r}\n      generated: {theirs!r}"
        for label, mine, theirs in zip(labels, on_disk, generated)
        if mine != theirs
    ]
    return "\n".join(lines)


def build_xlsx(sheet_title: str, rows: list[list[object]], column_widths: list[int]) -> bytes:
    """Render a single-sheet workbook into deterministic ``.xlsx`` bytes.

    The first row is treated as a header and bolded. Numbers are written as numbers (not
    strings) so the file is a real spreadsheet rather than a table of text — Bedrock's parser
    reads cell values either way, but a human opening it should see something usable.

    :param sheet_title: the worksheet name.
    :param rows: row data; ``rows[0]`` is the header row.
    :param column_widths: display width per column, same length as the header row.
    :return: the workbook bytes, with all timestamps pinned.
    """
    if len(column_widths) != len(rows[0]):
        raise ValueError(
            f"{len(column_widths)} column widths for {len(rows[0])} columns in {sheet_title!r}"
        )

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_title
    for row in rows:
        sheet.append(row)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for index, width in enumerate(column_widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width

    # Pin the document properties; openpyxl defaults `created` and `modified` to "now".
    workbook.properties.creator = "Reconciliation Operations"
    workbook.properties.lastModifiedBy = "Reconciliation Operations"
    workbook.properties.created = FIXED_DOC_TIMESTAMP
    workbook.properties.modified = FIXED_DOC_TIMESTAMP

    buffer = io.BytesIO()
    workbook.save(buffer)
    return _normalize_zip(buffer.getvalue())


# --------------------------------------------------------------------------------------
# Content — the attachments themselves
# --------------------------------------------------------------------------------------

# Every counterparty domain below is under an RFC 2606 / RFC 6761 reserved TLD (`.example`,
# `.example.com`, `.example.net`, `.example.org`). This is not cosmetic: the corpus is committed
# to git AND uploaded to S3, and a real counterparty address landing here would be an undetected
# data leak — secret scanners do not flag email addresses.
# `tests/kb_seed/test_metadata_sidecars.py::test_every_address_uses_a_reserved_domain`
# enforces it across the HTML, the sidecars and these attachments.
#
# ⚠️ The two PDFs are NOT invented. Each one is a specific notice from the loan-notice input
# corpus (`data/input/`, published as IDP evaluation ground truth under
# `data/input/idp-evaluation/`), so that a precedent the agent retrieves out of the knowledge base
# is a document IDP has ground-truth extractions for. Before editing a value below, check whether
# it also appears in the corresponding sample — if the two drift, the archive teaches identifier
# shapes that cannot occur in anything IDP extracts, which is the defect this replaced.
#
# Every label, value, heading and note is the sample's own. Two mechanical departures are forced
# by the renderer and are the ONLY licence taken:
#
#   1. Courier 9.5pt fits ~88 characters, and `_content_stream` does not wrap — an over-long line
#      is drawn off the MediaBox and clipped. The samples' 9-column accrual tables are therefore
#      reflowed into label/value pairs rather than truncated.
#   2. `build_pdf` rejects non-ASCII, so the samples' em dashes become hyphens.
#
# Nothing was added. In particular neither PDF says it is a copy of anything: that sentence would
# be the one line in the document the real notice does not contain, and it would be extracted and
# indexed along with the rest.

# Source: data/input/05-multi-facility-aggregated-wire/
#         One Wire for Multiple Facilities - Consolidated Payment Advice.pdf
# One wire, three facilities, one named lender — the aggregation break class in document form.
CONSOLIDATED_PAYMENT_ADVICE_PDF = [
    "Meridian Agency Services LLC - Consolidated Payment Advice",
    "",
    "To:      Tidelantern Senior Loan Fund, LP",
    "From:    Meridian Agency Services LLC, Loan Operations",
    "Phone:   212-555-3380",
    "Fax:",
    "Email:   loan.ops@meridian-agent.example",
    "",
    "  Field                  Value",
    "  ---------------------------------------------------------------------------",
    "  Lender                 Tidelantern Senior Loan Fund, LP",
    "  Borrower               CINDERMOOR LOGISTICS HOLDINGS, INC.",
    "  Credit Agreement       CINDERMOOR LOGISTICS HOLDINGS, INC. Credit Agreement",
    "",
    "Created on 27-Feb-2026",
    "",
    "Consolidated Payment Advice",
    "",
    "Payment Due Date: 02-Mar-2026",
    "",
    "This single wire aggregates cash across the Revolving Credit Facility, Term Loan A,",
    "and Term Loan B below.",
    "",
    "Cash Summary",
    "",
    "  Item                                          CCY        Amount",
    "  ---------------------------------------------------------------------",
    "  Revolving Credit Facility                     USD        4,182.55",
    "  Term Loan A - Interest                        USD        9,640.18",
    "  Term Loan B - Principal                       USD       12,500.00",
    "  ---------------------------------------------------------------------",
    "  Total USD:                                              26,322.73",
    "",
    "",
    "Revolving Credit Facility",
    "",
    "Borrower: CINDERMOOR LOGISTICS HOLDINGS, INC.",
    "Facility: Revolving Credit Facility $200MM",
    "",
    "  Outstanding Amount:      2,500,000.00",
    "  Currency:                USD",
    "  Day Count:               Actual/360",
    "  From / To:               30-Nov-2025 to 28-Feb-2026  (90 days)",
    "  All In Rate %:           7.52400",
    "  Total Interest Amount:   470,250.00",
    "  Cash Amount:             4,182.55",
    "",
    "CME Term SOFR Contract: CME TERM SOFR 11/30-2/28 (USD) Spread Adj: 0.15000%",
    "Basis: ACT/360",
    "Maturity Date: 3/15/2028",
    "Activity: Rollover - Interest",
    "Cash Amount (USD): 4,182.55",
    "",
    "",
    "Term Loan A",
    "",
    "Borrower: CINDERMOOR LOGISTICS HOLDINGS, INC.",
    "Facility: CINDERMOOR LOGISTICS TL-A $160MM   LoanXid: LX223061XXXX1",
    "",
    "  Outstanding Amount:      150,400,000.00",
    "  Currency:                USD",
    "  Day Count:               Actual/360",
    "  From / To:               30-Nov-2025 to 28-Feb-2026  (90 days)",
    "  All In Rate %:           7.32750",
    "  Total Interest Amount:   8,265,552.00",
    "  Cash Amount:             9,640.18",
    "",
    "CME Term SOFR Contract: CME TERM SOFR 11/30-2/28 (USD) Spread Adj: 0.15000%",
    "Basis: ACT/360",
    "Maturity Date: 3/15/2028",
    "Activity: Receive Accrued Interest - Interest",
    "Cash Amount (USD): 9,640.18",
    "",
    "",
    "Term Loan B",
    "",
    "Borrower: CINDERMOOR LOGISTICS HOLDINGS, INC.",
    "Facility: CINDERMOOR LOGISTICS TL-B $250MM",
    "",
    "  Global Amount:           250,000,000.00",
    "  Lender Share:            12,500.00",
    "  Accrual Period:          11/30/2025 - 2/28/2026",
    "  Base Rate:               4.57750%",
    "  Spread:                  3.25000%",
    "  Activity:                Early CME Term SOFR Paydown",
    "  Cash Amount:             12,500.00",
    "",
    "CME Term SOFR Contract: CME TERM SOFR 11/30-2/28 (USD) Spread Adj: 0.15000%",
    "Basis: ACT/360",
    "Maturity Date: 3/15/2029",
    "Activity: Early CME Term SOFR Paydown - Principal",
    "Cash Amount (USD): 12,500.00",
    "",
    "",
    "Aggregated Wire - USD wire instructions for Tidelantern Senior Loan Fund, LP",
    "",
    "USD 26,322.73",
    "",
    "Reference: CINDERMOOR LOGISTICS HOLDINGS, INC. $850MM 3/15/2021",
    "Comments: Kindly apply funds accordingly.",
    "",
    "  Field                 Value",
    "  ------------------------------------------------------------------------",
    "  Bank Name:            TARNSMOOR TRUST BANK, N.A. New York (STBKUS33)",
    "  ABA Number:           121000341",
    "  SWIFT Code:           STBKUS33",
    "  Account Name:         Tidelantern Senior Loan Fund, LP",
    "  Account Number:       ****7305",
    "",
    "Note: This single wire aggregates cash across the Revolving Credit Facility,",
    "Term Loan A, and Term Loan B above.",
    "",
    "",
    "Produced by Meridian Agency Services LLC",
    "Run date 2/26/2026",
]

# Source: data/input/03-paydown-principal-notices/Paydown Notice - Unmapped Facility.pdf
# The corpus's own instance of a notice issued WITHOUT a LoanX identifier, and — unlike the
# invented notice this replaced — it states the real reason: the facility was novated from a
# predecessor agent and the identifier has not been reissued.
UNMAPPED_FACILITY_PAYDOWN_PDF = [
    "Message Originated From: loan.ops@tarnsmoor-trust.example",
    "",
    "                             Tarnsmoor Trust Bank, N.A.",
    "                                Loan Operations",
    "",
    "Date: 26-Feb-2026",
    "TO: EVERGREEN SPECIALTY FINANCE INC.",
    "ATTN: Loan Administration",
    "Re: CINDERMOOR LOGISTICS TL-B 2022/06/30",
    "",
    "                   ***** Principal Paydown *****",
    "",
    "Effective: 02-Mar-2026",
    "",
    "Facility: CINDERMOOR LOGISTICS TL-B $250MM",
    "Facility ID: SL-99001",
    "Reference: WIRE-20260302-EVG",
    "",
    "NOTE: This facility was novated from a predecessor agent on 14-Jan-2026. The",
    "LoanX identifier has not yet been reissued and is omitted from this notice.",
    "",
    "Borrower CINDERMOOR LOGISTICS HOLDINGS INC. will make the following early",
    "principal paydown:",
    "",
    "Description                    Global Amount        Your Share",
    "Early Paydown Principal         2,500,000.00         12,500.00",
    "",
    " Rate Basis: Actual/360",
    " Currency: USD",
    "",
    "Portfolio: Direct Lending Fund I",
    "Agent Bank: Tarnsmoor Trust Bank, N.A.",
    "Contact: Loan Administration loan.ops@tarnsmoor-trust.example    +1-555-0188",
]

# The lender's own working paper behind the consolidated advice above: the three components the
# single USD 26,322.73 wire has to be split into. Unlike the PDFs this is not a copy of a sample —
# the notice corpus contains no spreadsheets — but every identifier in it is drawn from one:
#
#   * `SL-204833` is the revolver's Facility ID, from `Interest Notice - Global Amount Only.pdf`
#     (same facility: CINDERMOOR REVOLVING CREDIT FACILITY $200MM).
#   * `LX223061XXXX1` is printed on the advice itself, and is deliberately recorded here EXACTLY as
#     printed rather than resolved to `LX223061`. The truncation rule lives in the covering
#     correspondence, and a schedule that silently pre-resolved it would hide the trap.
#   * `SL-99001` is the TL-B Facility ID, from `Paydown Notice - Unmapped Facility.pdf` above.
#
# There is no CUSIP column: the Cindermoor notices print facility IDs and never CUSIPs, so a CUSIP
# column could only have been filled by inventing one.
FACILITY_ALLOCATION_XLSX = {
    "sheet_title": "Cindermoor Wire Allocation",
    "column_widths": [34, 28, 16, 13, 13, 12, 16],
    "rows": [
        [
            "Facility",
            "Activity",
            "LoanX ID",
            "Facility ID",
            "Amount USD",
            "Day count",
            "All-in rate pct",
        ],
        [
            "Revolving Credit Facility $200MM",
            "Rollover - Interest",
            "",
            "SL-204833",
            4182.55,
            "ACT/360",
            7.52400,
        ],
        [
            "CINDERMOOR LOGISTICS TL-A $160MM",
            "Receive Accrued Interest",
            "LX223061XXXX1",
            "",
            9640.18,
            "ACT/360",
            7.32750,
        ],
        # Day count and rate are blank on purpose: this row is a principal paydown, so the advice's
        # base rate and spread do not price a cash amount here. The previous sheet used the same
        # convention for its principal row.
        [
            "CINDERMOOR LOGISTICS TL-B $250MM",
            "Early CME Term SOFR Paydown",
            "",
            "SL-99001",
            12500.00,
            "",
            "",
        ],
        ["TOTAL", "", "", "", 26322.73, "", ""],
    ],
}

FX_REVALUATION_XLSX = {
    "sheet_title": "FX Reval Jun-2026",
    "column_widths": [14, 12, 16, 14, 14, 16, 16, 14],
    "rows": [
        [
            "Trade ref",
            "Currency",
            "Local amount",
            "Custodian rate",
            "Ledger rate",
            "Custodian USD",
            "Ledger USD",
            "Difference USD",
        ],
        ["TR-771204", "EUR", 2400000.00, 1.08412, 1.08409, 2601888.00, 2601816.00, 72.00],
        ["TR-771318", "GBP", 1150000.00, 1.27055, 1.27051, 1461132.50, 1461086.50, 46.00],
        ["TR-771402", "CHF", 880000.00, 1.11840, 1.11838, 984192.00, 984174.40, 17.60],
        ["TR-771455", "JPY", 310000000.00, 0.00662, 0.00662, 2052200.00, 2052200.00, 0.00],
        ["TOTAL", "", "", "", "", 7099412.50, 7099276.90, 135.60],
    ],
}


def _artifacts() -> dict[str, bytes]:
    """Build every attachment, keyed by filename relative to the email directory.

    :return: mapping of filename to file bytes.
    """
    return {
        "20260226-paydown-notice-unmapped-facility.pdf": build_pdf(UNMAPPED_FACILITY_PAYDOWN_PDF),
        "20260227-consolidated-payment-advice-cindermoor.pdf": build_pdf(
            CONSOLIDATED_PAYMENT_ADVICE_PDF
        ),
        "20260227-facility-allocation-cindermoor.xlsx": build_xlsx(**FACILITY_ALLOCATION_XLSX),
        "20260718-fx-revaluation-detail-JUN26.xlsx": build_xlsx(**FX_REVALUATION_XLSX),
    }


def main() -> int:
    """Write the attachments, or verify the committed ones are current.

    :return: process exit status; 0 on success, 1 if ``--check`` found a mismatch.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed files match this script instead of rewriting them",
    )
    arguments = parser.parse_args()

    artifacts = _artifacts()
    if arguments.check:
        stale: list[str] = []
        for name, payload in artifacts.items():
            path = EMAIL_DIR / name
            if not path.is_file():
                stale.append(name)
                continue
            # Workbooks are compared by declared content, not bytes: openpyxl's XML serializer
            # differs with/without lxml, so byte-identity does not survive a change of machine.
            # See the ⚠️ note in _normalize_zip.
            committed = path.read_bytes()
            if name.endswith(".xlsx"):
                if not _xlsx_matches(committed, payload):
                    stale.append(name)
            elif committed != payload:
                stale.append(name)
        if stale:
            print(
                "these attachments do not match the generator "
                f"(re-run without --check): {sorted(stale)}",
                file=sys.stderr,
            )
            for name in sorted(stale):
                path = EMAIL_DIR / name
                if path.is_file():
                    print(_describe_mismatch(path.read_bytes(), artifacts[name]), file=sys.stderr)
            return 1
        print(f"{len(artifacts)} attachments are up to date")
        return 0

    EMAIL_DIR.mkdir(parents=True, exist_ok=True)
    for name, payload in artifacts.items():
        (EMAIL_DIR / name).write_bytes(payload)
        print(f"wrote {name} ({len(payload):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
