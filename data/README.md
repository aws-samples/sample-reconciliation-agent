# Synthetic Reconciliation Sample Documents

These files are **synthetic (fake but realistic)** versions of syndicated-loan /
credit-agreement notices used to demo the **unapplied cash reconciliation**
workflow app. They mirror the structure, field labels, section headings, and
tabular layout of typical files with a clearly synthetic-but-plausible value.

**No real PII, real company names, real account numbers, or real CUSIPs appear
in these files.** They are safe to ingest into the reconciliation app and to
share for demo/testing purposes.

## Synthetic universe (consistent across all files)

- **Borrowers:** Northwind Manufacturing LLC, Cindermoor Logistics Holdings Inc.,
  Mistfell Foods Corp.
- **Administrative Agent:** Tarnsmoor Trust Bank, N.A. (also "Meridian Agency
  Services LLC" and "Tarnsmoor Trust Capital LLC" as agent/servicer variants)
- **Lenders / holders:** Evergreen Credit CLO 2020-1 Limited, Harborlight Senior
  Loan Fund LP, Evergreen Specialty Finance Inc., Northwind Credit Managed
  Account (SYN) LP
- **Facilities:** Term Loan A, Term Loan B, Revolving Credit Facility (plus DDTL
  commitments)
- **Reference rate:** Term SOFR + spread (2.75%–3.25%), day count Actual/360
- **CUSIPs:** synthetic 9-char values, e.g. `SYN00031A`, `SYN00041B`
- **Loan IDs:** synthetic LoanXIDs, e.g. `LX204811XXXX1`
- **ABA numbers:** synthetic 9-digit values, e.g. `021000341`
- **Account numbers:** masked, e.g. `****4821`
- **Dates:** 2026 (some accruals span late 2025 into 2026)

## Folder contents

Each folder holds one representative document per reconciliation behavior. Ten
documents in total cover the ten rows in `general-ledger/gl-entries.csv`, plus
the deliberate non-matching / exception cases the agent must escalate or reject.

| Folder                               | Contents                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-borrowing-notices/`              | One borrowing (facility draw) notice for a known borrower. A draw disburses cash and has **no** corresponding cash-receipt GL row, so it is expected **not** to reconcile — exercises the unmatched-draw path.                                                                              |
| `02-interest-and-rate-set-notices/`  | An interest payment / rate-set notice with Term SOFR accrual line items that **cleanly matches** its GL row (Tier-1), plus a commitment-fee notice that is a **near-miss** (same borrower/facility/fee type as a GL fee row, but a different amount) — exercises the discrepancy path.      |
| `03-paydown-principal-notices/`      | An optional and a mandatory principal paydown notice that each **cleanly match** a single GL row (Tier-1), plus a combined paydown + interest notice whose two line items map to **two** GL rows — exercises multi-line Tier-2 escalation.                                                  |
| `04-cancellation-notices/`           | One borrowing/DDTL-draw cancellation notice. A cancellation derives a **debit** and therefore cannot match the credit GL rows even when the borrower and facility overlap — exercises the direction-mismatch rejection.                                                                     |
| `05-multi-facility-aggregated-wire/` | Three single-wire-for-multiple-facilities documents: a Consolidated Payment Advice whose components map to **three** GL rows (Tier-2 aggregated-wire escalation), a Summary Statement that **cleanly matches** one GL row, and an Activity Memo whose fee component matches one GL fee row. |
