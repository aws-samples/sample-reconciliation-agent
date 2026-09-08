#!/usr/bin/env python3
"""Generate the synthetic agent-bank notices under ``data/input/`` that this repo authors itself.

The ten notices that predate this script are committed binaries with no generator. These six are
different: each one exists to make exactly ONE reconciliation outcome reachable, and that intent lives
in the notice's text. A committed PDF with no source is a fixture nobody can review — you cannot diff
it, cannot tell which line makes it the case it claims to be, and cannot correct a figure without a PDF
editor. So these are build artefacts of this script, and the script is their only source of truth.

``build_pdf`` is imported from ``generate_kb_email_attachments`` rather than reimplemented. It writes
UNCOMPRESSED content streams, which matters beyond determinism: the address sweep in
``tests/input_corpus/`` greps the raw bytes, and a compressed stream would hide a real address from it.

Every value here is synthetic and stays inside the universe documented in ``data/README.md``. Email
addresses use RFC 2606 / 6761 reserved domains, which cannot resolve.

Usage::

    python3 scripts/generate_input_notices.py            # write the files
    python3 scripts/generate_input_notices.py --check    # verify the committed files are current
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_kb_email_attachments import build_pdf  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = REPO_ROOT / "data" / "input"

# ⚠️ Pinned to `GL-2026-000111`'s amount in data/general-ledger/gl-entries.csv. The EUR notice below and
# that ledger row have to agree, and a figure agreed across two files by hand drifts — so it is declared
# once, here, and tests/input_corpus asserts the ledger row still carries it.
EUR_FEE_AMOUNT = "412.50"
EUR_FEE_REFERENCE = "MF-FEE-EUR-1119"

# The facility id with no crosswalk entry. Deliberately outside the `LX00418xx` series the ledger
# carries, because the point of the notice is that asset identity cannot be CORROBORATED — not that it
# conflicts.
UNMAPPED_FACILITY_ID = "SL-99001"


# --- Medium band, via a global-only amount ---------------------------------------------------------
# Prints a Global Amount column and NO Your Share column. Fund, date and facility all line up with
# GL-2026-000103, so three of the four core dimensions align and the fourth is UNAVAILABLE rather than
# wrong. That is the AM2/AM5 case: the agent must report fund-level amount validation as unavailable and
# must not reach the top band on it.
GLOBAL_AMOUNT_ONLY = [
    "Message Originated From: loan.ops@meridian-agent.example",
    "",
    "                               Meridian Agency Services LLC",
    "                                 Loan Operations",
    "",
    "Date: 26-Feb-2026",
    "TO: EVERGREEN CREDIT CLO 2020-1, LIMITED",
    "ATTN: Dana Whitfield",
    "Re: CINDERMOOR LOGISTICS REVOLVER 2022/06/30",
    "",
    "                   ***** Interest Payment *****",
    "",
    "Effective: 02-Mar-2026",
    "",
    "Facility: CINDERMOOR REVOLVING CREDIT FACILITY $200MM",
    "Facility ID: SL-204833",
    "",
    "Borrower CINDERMOOR LOGISTICS HOLDINGS INC. in Facility CINDERMOOR REVOLVING",
    "CREDIT FACILITY $200MM will make the following interest payments:",
    "",
    "Description                                    Global Amount",
    "Term SOFR Rollover Interest                       418,255.00",
    "",
    "NOTE: Lender-level allocations for this payment are issued separately by the",
    "administrative agent. This notice states the facility total only.",
    "",
    " Rate Basis: Actual/360",
    " Currency: USD",
    "",
    "Portfolio: Direct Lending Fund I",
    "Agent Bank: Meridian Agency Services LLC",
    "Contact: Dana Whitfield  loan.ops@meridian-agent.example  +1-555-0142",
]

# --- Currency as the discriminator -----------------------------------------------------------------
# A EUR fee notice. Two ledger candidates sit in its window: EUR GL-2026-000111 (a match) and USD
# GL-2026-000110 at 446.67 (a near-miss). The agent must reject the USD one on incompatible currency
# rather than on the amount difference, which is the disqualifier this pair exists to exercise.
EUR_COMMITMENT_FEE = [
    "Message Originated From: fees@tarnsmoor-trust.example",
    "",
    "                             Tarnsmoor Trust Bank, N.A.",
    "                                Agency Fee Services",
    "",
    "Date: 17-Nov-2026",
    "TO: HARBORLIGHT SENIOR LOAN FUND LP",
    "ATTN: Fee Administration",
    "Re: MISTFELL FOODS REVOLVER 2023/11/30",
    "",
    "                   ***** Commitment Fee Notice *****",
    "",
    "Effective: 19-Nov-2026",
    "",
    "Facility: MISTFELL REVOLVING CREDIT FACILITY EUR 90MM",
    "Facility ID: SL-311907",
    f"Reference: {EUR_FEE_REFERENCE}",
    "",
    "Borrower MISTFELL FOODS CORP. commitment fee for the period 01-Nov-2026 to",
    "17-Nov-2026, computed on the undrawn commitment.",
    "",
    "Description                    Fee Percentage        Your Share",
    f"Commitment Fee                       0.375%            {EUR_FEE_AMOUNT}",
    "",
    " Rate Basis: Actual/360",
    " Currency: EUR",
    "",
    "IMPORTANT: This facility is denominated in EUR. The borrower also maintains a",
    "USD revolving facility; fees on that facility are noticed separately.",
    "",
    "Portfolio: Senior Credit Fund",
    "Agent Bank: Tarnsmoor Trust Bank, N.A.",
    "Contact: Fee Administration  fees@tarnsmoor-trust.example  +1-555-0177",
]

# --- Scenario 4 overlay: no standalone cash --------------------------------------------------------
# A rollover with no payment line at all. The existing "Interest Payment & Rate Set Notice.pdf" bundles
# a rate set WITH an interest payment, so it does move cash; this one does not, which is what makes it
# the rollover-without-cash case. Both contract ids are present because they are the evidence of the
# linked
# event, and the comment states R2's conclusion in the source's own words.
ROLLOVER_RATE_SET = [
    "Message Originated From: loan.ops@meridian-agent.example",
    "",
    "                               Meridian Agency Services LLC",
    "                                 Loan Operations",
    "",
    "Date: 22-Jan-2026",
    "TO: EVERGREEN CREDIT CLO 2020-1, LIMITED",
    "ATTN: Dana Whitfield",
    "Re: NORTHWIND MANUFACTURING 1L 2022/07/09",
    "",
    "                   ***** Rate Setting *****",
    "",
    "Description: USD Loan Rollover for the Deal NORTHWIND MANUFACTURING 1L",
    "2022/07/09. No principal or interest is payable on this event.",
    "",
    "Effective: 26-Jan-2026",
    "",
    "Facility: NORTHWIND REVOLVING CREDIT FACILITY LoanXid: LX204899XXXX1",
    "Facility ID: SL-204899",
    "",
    "Contract ID: CT-204899-A",
    "New Contract ID: CT-204899-B",
    "",
    "Borrower NORTHWIND MANUFACTURING LLC in Facility NORTHWIND REVOLVING CREDIT",
    "FACILITY has the following loans rolling over:",
    "",
    "                                                    Current      Next",
    "Pricing Option           Global Amount           Reprice     Reprice",
    "Term SOFR 1 Month        24,000,000.00        26-Jan-2026 26-Feb-2026",
    "",
    " Look Back days : 2",
    " Spread Adjustment : 0.000000%",
    "",
    "Notice Comment: only rollover notice - no standalone cash movement is",
    "expected for this event; interest accrues to the next payment date.",
    "",
    "Portfolio: DL Fund II",
    "Agent Bank: Meridian Agency Services LLC",
    "Contact: Dana Whitfield  loan.ops@meridian-agent.example  +1-555-0142",
]

# --- Medium band, via unavailable asset identity ---------------------------------------------------
# Fund, date and amount all match GL-2026-000105 exactly. What is missing is corroboration of asset
# identity: the notice carries a source facility id with no crosswalk entry and NO LoanXid. An ABSENCE
# of proof, not a conflict — which is Medium, not Disqualified, and the distinction is the whole point.
UNMAPPED_FACILITY_PAYDOWN = [
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
    f"Facility ID: {UNMAPPED_FACILITY_ID}",
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
    "Contact: Loan Administration  loan.ops@tarnsmoor-trust.example  +1-555-0188",
]

# --- Disqualified: fund mismatch -------------------------------------------------------------------
# Everything about this notice looks like GL-2026-000108 — borrower, facility, date, amount — EXCEPT the
# portfolio, which resolves cleanly to a DIFFERENT fund. The lesson it teaches is that a resolvable
# alias is not a matching fund: the alias table succeeding is not the same as the dimension aligning.
OTHER_FUND_INTEREST = [
    "Message Originated From: loan.ops@tarnsmoor-trust.example",
    "",
    "                             Tarnsmoor Trust Bank, N.A.",
    "                                Loan Operations",
    "",
    "Date: 12-Sep-2026",
    "TO: NORTHWIND CREDIT MANAGED ACCOUNT (SYN) LP",
    "ATTN: Loan Administration",
    "Re: MISTFELL FOODS 1L 2023/11/30",
    "",
    "                   ***** Interest Payment *****",
    "",
    "Effective: 15-Sep-2026",
    "",
    "Facility: MISTFELL INITIAL TERM LOANS LoanXid: LX0052901",
    "Facility ID: SL-311842",
    "Reference: MF-INT-0915-OCF",
    "",
    "Borrower MISTFELL FOODS CORP. will make the following interest payment:",
    "",
    "Description                    Global Amount        Your Share",
    "Term SOFR Term Interest        41,250,000.00        618,750.00",
    "",
    " Rate Basis: Actual/360",
    " Currency: USD",
    "",
    "Portfolio: Opp Credit",
    "Agent Bank: Tarnsmoor Trust Bank, N.A.",
    "Contact: Loan Administration  loan.ops@tarnsmoor-trust.example  +1-555-0188",
]

# --- Unknown / insufficient data -------------------------------------------------------------------
# A truncated fax cover sheet: a borrower name and nothing else usable. No fund, no date, no amount, no
# identifier: only the issuer text aligns — and the requirement is that the case says WHICH data
# was missing, rather than reporting a generic failure to match.
PARTIAL_FAX_COVER = [
    "*** INCOMING FAX - PAGE 1 OF 4 ***",
    "*** PAGES 2-4 NOT RECEIVED - TRANSMISSION ERROR ***",
    "",
    "                             Tarnsmoor Trust Bank, N.A.",
    "                                Loan Operations",
    "",
    "TO: LOAN ADMINISTRATION",
    "FROM: AGENCY SERVICES",
    "",
    "Re: NORTHWIND MANUFACTURING LLC",
    "",
    "Please see the attached notice regarding the above referenced borrower.",
    "",
    "Questions to the contact shown on page 2.",
    "",
    "*** END OF RECEIVED PAGES ***",
]


def artifacts() -> dict[str, bytes]:
    """Build every generated notice, keyed by path relative to ``data/input/``.

    :returns: mapping of relative path to file bytes.
    """
    return {
        "02-interest-and-rate-set-notices/Interest Notice - Global Amount Only.pdf": build_pdf(
            GLOBAL_AMOUNT_ONLY
        ),
        "02-interest-and-rate-set-notices/Commitment Fee Notice - EUR.pdf": build_pdf(
            EUR_COMMITMENT_FEE
        ),
        "02-interest-and-rate-set-notices/Rollover Rate Set Notice.pdf": build_pdf(
            ROLLOVER_RATE_SET
        ),
        "02-interest-and-rate-set-notices/Interest Notice - Other Fund.pdf": build_pdf(
            OTHER_FUND_INTEREST
        ),
        "03-paydown-principal-notices/Paydown Notice - Unmapped Facility.pdf": build_pdf(
            UNMAPPED_FACILITY_PAYDOWN
        ),
        "06-incomplete-notices/Agent Notice - Partial Fax Cover.pdf": build_pdf(PARTIAL_FAX_COVER),
    }


def main() -> int:
    """Write the notices, or verify the committed ones are current.

    :returns: process exit status; 0 on success, 1 when ``--check`` found a mismatch.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed files match this script instead of rewriting them",
    )
    arguments = parser.parse_args()

    built = artifacts()
    if arguments.check:
        stale = [
            name
            for name, payload in built.items()
            if not (INPUT_DIR / name).is_file() or (INPUT_DIR / name).read_bytes() != payload
        ]
        if stale:
            print("stale or missing generated notices:", file=sys.stderr)
            for name in stale:
                print(f"  {name}", file=sys.stderr)
            print("run: python3 scripts/generate_input_notices.py", file=sys.stderr)
            return 1
        print(f"{len(built)} generated notices are current")
        return 0

    for name, payload in built.items():
        path = INPUT_DIR / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        print(f"wrote {path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
