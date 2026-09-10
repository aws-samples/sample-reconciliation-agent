# Synthetic Reconciliation Sample Documents

> **Setup, before anything below makes sense.** The notice store starts **empty**. Nothing seeds it —
> notices exist only where a document has been through extraction, so the first step of any demo or
> test run is uploading one of the documents in `input/` through the console. An empty actual side on a
> freshly applied environment is the designed state, not a broken one.
>
> See `input/IDP-EXTRACTION-REQUIREMENTS.md` for the field contract extraction has to satisfy for those
> uploads to produce useful notices, and `idp-extraction-config/` for a configuration that satisfies it
> — an upload whose extraction emits the right values under the wrong key names produces a notice with
> every field blank and reports no error at all.

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

## What each document is FOR

Every document exists to make exactly one reconciliation outcome reachable. That intent is the reason
the corpus is the size it is, and it is what a test or a demo is actually exercising.

**Read the band column knowing where the ceiling is.** MEDIUM is the highest band this platform can
award: the band above it requires evidence that a source system has finalised the record, and no
source connected here produces that. That is a decision, not a gap — there is deliberately no
`internal_validation_status` on a notice and no path by which a human marks one reviewed, so no case
can ever be corroborated that way. Changing the ceiling means revisiting that first.

| Document                                      | Ledger counterpart                | Scenario | Band          | What decides it                                                                                   |
| --------------------------------------------- | --------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `02/Interest Payment & Rate Set Notice.pdf`   | `GL-2026-000107`                  | 1        | MEDIUM        | all four core dimensions align; MEDIUM is the ceiling                                             |
| `02/Interest Notice - Global Amount Only.pdf` | `GL-2026-000103`                  | 1        | MEDIUM        | `amount` absent, only a facility-wide total in `idp_sections` — fund-level validation unavailable |
| `02/Commitment Fee Notice.pdf`                | `GL-2026-000110` (near miss)      | 3        | MEDIUM        | same borrower, facility and fee type; a different amount                                          |
| `02/Commitment Fee Notice - EUR.pdf`          | `GL-2026-000111` (EUR)            | 3        | MEDIUM / DISQ | currency: the EUR row matches, USD `…000110` is disqualified on it                                |
| `02/Rollover Rate Set Notice.pdf`             | `GL-2026-000109`                  | 4        | capped        | `activity_type = Rollover`, no payment line — no standalone cash expected                         |
| `02/Interest Notice - Other Fund.pdf`         | none (resembles `GL-2026-000108`) | Unknown  | DISQUALIFIED  | the fund alias resolves cleanly — to the wrong fund                                               |
| `03/Optional Paydown Notice.pdf`              | `GL-2026-000105`                  | 1        | MEDIUM        | clean single-row match                                                                            |
| `03/Mandatory Paydown Notice.pdf`             | `GL-2026-000108`                  | 1        | MEDIUM        | clean single-row match                                                                            |
| `03/Paydown and Interest Notice.pdf`          | `GL-2026-000101` + `…000102`      | 1        | MEDIUM        | two line items, two ledger rows — multi-line escalation                                           |
| `03/Paydown Notice - Unmapped Facility.pdf`   | `GL-2026-000105`                  | 1        | MEDIUM        | `SL-99001` with no crosswalk entry — asset identity unavailable                                   |
| `01/Borrowing Notice.pdf`                     | none (a draw disburses cash)      | Unknown  | no match      | a draw has no cash-receipt row to match                                                           |
| `04/Borrowing Cancellation Notice.pdf`        | none (direction conflict)         | Unknown  | DISQUALIFIED  | derives a DEBIT; every ledger row here is a CREDIT                                                |
| `05/… Consolidated Payment Advice.pdf`        | `…000103` + `…000104` + `…000105` | 1        | MEDIUM        | one wire, three components — sum-to-total aggregation                                             |
| `05/… Summary Statement.pdf`                  | one ledger row                    | 1        | MEDIUM        | clean single-row match                                                                            |
| `05/… Activity Memo.pdf`                      | one ledger fee row                | 1        | MEDIUM        | fee component matches a fee row                                                                   |
| `06/Agent Notice - Partial Fax Cover.pdf`     | none                              | Unknown  | DISQUALIFIED  | only the borrower name is legible — issuer text alone is never enough                             |

There is deliberately **no row for the top band**. It would be a case that can only fail.

### Generated versus committed documents

Six of these are build artefacts of `scripts/generate_input_notices.py` — the four `02/` additions, the
`03/` unmapped-facility notice, and the `06/` fax cover. Edit the script, not the PDFs;
`tests/input_corpus/` fails when the two disagree. The other ten predate that script and are committed
binaries with no generator.

The generator writes **uncompressed** PDF content streams. That is not a size trade-off: the corpus
sweep greps the raw bytes for email addresses, and a compressed stream would hide a real address from
the one check that looks for it.

### Folders

| Folder                               | Holds                                                             |
| ------------------------------------ | ----------------------------------------------------------------- |
| `01-borrowing-notices/`              | facility draws — cash out, so no receipt row to reconcile against |
| `02-interest-and-rate-set-notices/`  | interest, rate sets, rollovers, commitment fees                   |
| `03-paydown-principal-notices/`      | principal paydowns, mandatory and optional                        |
| `04-cancellation-notices/`           | cancellations — a DEBIT, which cannot match a credit row          |
| `05-multi-facility-aggregated-wire/` | one wire covering several facilities, in three document shapes    |
| `06-incomplete-notices/`             | documents that arrived truncated or unreadable                    |

## The extraction configuration

`idp-extraction-config/classes.json` is the class-schema half of the deployed extraction
configuration, tracked here because its only other home is the document pipeline's DynamoDB table —
where it can drift away from the contract with nothing able to notice. See that folder's README;
`scripts/push_idp_extraction_config.py` installs it and `tests/input_corpus/test_extraction_config.py`
holds it against both the contract and the ground truth above.

## The expected side

`general-ledger/gl-entries.csv` is the book of record for the matrix above: 11 rows, one non-USD
(`GL-2026-000111`, EUR), each carrying a fund code, an expected value date, identifier columns and an
activity type.

⚠️ Its column order is a **positional contract** with the Glue table in `infra/modules/gl-mock/main.tf`.
`LazySimpleSerDe` maps CSV columns by position, so a header that disagrees with that schema does not
error — Athena returns values under the wrong column names. Append only, to both at once.

## The guidance corpus

`kb-seed/` holds what the agent retrieves rather than what it reconciles: five class playbooks, an
archive of counterparty correspondence, and `source-selection.md` on which source answers which
question. The playbooks carry **precedent and convention only** — procedure lives in the skills, and
policy in the shared-core system prompt, because a rule reached by a filtered search is a rule that is
sometimes absent.
