# Loan-notice test sets

Six accelerator evaluation test sets built from the syndicated-loan notice corpus two levels up
([`data/input/`](../../)) — **one per source subfolder**, so a run can be scoped to a single notice
family. Generated; see [`../README.md`](../README.md) for where the generator lives.

| Test set              | Source subfolder                     | Docs | Classes covered                                                                 |
| --------------------- | ------------------------------------ | ---: | ------------------------------------------------------------------------------- |
| `01-BORROWING`        | `01-borrowing-notices/`              |    1 | `borrowing_notice`                                                              |
| `02-INTEREST-RATESET` | `02-interest-and-rate-set-notices/`  |    6 | `interest_rate_set_notice`, `commitment_fee_notice`, `rollover_rate_set_notice` |
| `03-PAYDOWN`          | `03-paydown-principal-notices/`      |    4 | `paydown_notice`                                                                |
| `04-CANCELLATION`     | `04-cancellation-notices/`           |    1 | `cancellation_notice`                                                           |
| `05-AGGREGATED-WIRE`  | `05-multi-facility-aggregated-wire/` |    3 | `consolidated_payment_advice`, `activity_memo`, `summary_statement`             |
| `06-INCOMPLETE`       | `06-incomplete-notices/`             |    1 | `incomplete_notice`                                                             |

All 10 classes in the requirements doc's §1 are covered. 16 documents, 16 sections.

The same corpus and the same ground truth also exist in the accelerator's other evaluation form — the
input bucket plus the evaluation baseline bucket — under
[`../ground-truth/`](../ground-truth/README.md). The `result.json` files are
byte-identical between the two; only the layout and the delivery differ.

## ⚠️ There is no matching extraction configuration yet

The accelerator's shipped configurations define none of these classes — grep the config library for
`borrowing_notice` and you get nothing. **Uploaded and run today, every one of these test sets scores
0**, and the zero is a missing configuration, not a model failure.

That is the intended order of work: these test sets are the specification the configuration has to
satisfy. Author the classes and attributes to match, then the score starts meaning something.

## Files

```
data/input/idp-evaluation/testsets/
├── <FAMILY>/
│   ├── input/<document>.pdf
│   └── baseline/<document>.pdf/sections/1/result.json
└── <FAMILY>.zip          # upload archive, <FAMILY>/input/… + <FAMILY>/baseline/…
```

`<FAMILY>.zip` is what **Add Test Set from Upload** takes. The extractor
(`genai-idp-terraform`, `sources/src/lambda/test_set_zip_extractor/index.py`) requires both an `input/` and a `baseline/`
segment in every path and rejects the upload when the input filenames and the baseline document
folder names are not the same set — including a baseline with no matching input. Nothing but `input/`
and one baseline tree may go into a zip.

The zips themselves are **not committed** — `.gitignore` excludes them, and they are pure derivatives
of the trees beside them. Run the generator to get them.

## Regenerating

Never hand-edit anything under this directory. The baselines are build artefacts. The generator lives
in the **`genai-idp-terraform` repo**, not this one; run it from there and it writes back into this
folder (see [`../README.md`](../README.md)):

```bash
python3 scripts/build_loan_notice_testsets.py
python3 scripts/build_loan_notice_testsets.py --source-dir /path/to/data/input   # corpus elsewhere
```

The ground truth is declared as data in the script's `TRUTH` table, next to the note recording how
each non-obvious value was decided. A value edited in the JSON loses that record and is silently
reverted by the next build.

The build **fails** when a declared document is missing from the corpus, when a PDF's real page count
differs from the declared one (its `page_indices` are derived from that count, so a re-paginated PDF
would otherwise ship unmatchable split truth), and when `TRUTH` names a subfolder that is not a
family.

## Baseline shape

```json
{
  "document_class": { "type": "paydown_notice" },
  "split_document": { "page_indices": [0, 1] },
  "classification": "paydown_notice",
  "page_ids": ["1", "2"],
  "confidence": 1.0,
  "inference_result": { "notice_date": "2026-09-15", "...": "..." }
}
```

Three things about this shape are load-bearing:

- **`inference_result`, not `attributes`.** Evaluation runs prediction and baseline through the same
  unwrapping, which knows only `inference_result`. Under an `attributes` wrapper every field lands one
  level too deep, so each correct extraction is scored as a false positive — with no error anywhere.
- **`page_indices` are 0-based**; `page_ids` are **1-based strings**, mirroring the pipeline's own
  `pages/<n>/` naming. They describe the same pages in two conventions.
- **Sections match positionally** on the `sections/<n>/` directory name against the pipeline's own
  1..N page-order numbering. Every document here is one logical notice, so each has exactly one
  section, numbered `1`, spanning all of its pages. Continuation and duplicate pages carry no second
  class: page 2 of `Borrowing Notice.pdf` is page 1 reprinted.

## Authoring conventions

Ground truth was read off each document's own text, never off a model's output — grading a prediction
against itself measures nothing. Field keys and class values come from
[`IDP-EXTRACTION-REQUIREMENTS.md`](../../IDP-EXTRACTION-REQUIREMENTS.md). Where that document leaves a choice open:

- **`counterparty` is the borrower/issuer**, never the addressee lender. The notices address the
  lender and report on the borrower; §2's own example (`NORTHWIND MANUFACTURING LLC`, the borrower)
  settles it.
- **`fund` is the `Portfolio:` line where one is printed**, otherwise the addressee fund. On
  `Interest Notice - Other Fund.pdf` the two deliberately disagree, and the `Portfolio:` value is the
  one the document is built to test.
- **`facility` is omitted on the two multi-facility aggregates.** A single-valued key cannot name
  three facilities, and naming one of them is worse than saying nothing.
- **`cusip` / `isin` are facility-level.** Several notices print a deal-level pair too; it is not the
  answer (see the §2 example note below).
- **Amounts are decimal strings without separators** (`"9822.30"`), dates ISO in `notice_date` with
  the printed form preserved verbatim in `notice_date_source_raw`.
- **Absence follows §4's three states exactly.** A key with a value, a key with `""` when the label is
  printed and empty, and **no key at all** when the field does not apply. Emitting `0`, `-` or `N/A`
  for an absent field destroys the distinction the platform acts on.

## Three places the source contract contradicts itself

Flagged rather than quietly resolved. Each is a one-line change in the generator if the call goes the
other way.

**1. `amount` for `Interest Payment & Rate Set Notice.pdf`.** §2's example column gives
`1512361.04`, and `GL-2026-000107` carries that figure as an "Interest payment share". But §5 — "the
single most consequential instruction in this document" — works its `Your Share` → `amount` rule on
_this document's own_ interest row:

```
Description            Global Amount      Your Share
Term SOFR Term         3,939,077.64         9,822.30
```

and the notice itself says "We will remit your funds USD 9,822.30". 1,512,361.04 appears on the
document as a loan **balance**, not a payment. The baseline applies §5: `amount` `9822.30`,
`global_amount` `3939077.64`. If §2's table is right, then either the ledger row or §5's worked
example needs correcting — the three cannot all stand.

**2. §2's `cusip` example.** The example value `SYN00031A` is the **deal**-level CUSIP of that sample
document, while §2's own rule for the field says facility-level. The baseline follows the rule
(`SYN00033C`), not the example.

**3. `03/Paydown and Interest Notice.pdf` reports two activities.** A principal payment
(400,000.00 global / 8,317.07 share) and an interest payment (2,052,425.70 / 42,675.44), remitted
together as USD 50,992.51. The single-valued `amount` + `activity_type` pair can carry only one, so
the baseline encodes the principal line, matching the document's `paydown_notice` class — and the
interest half of the document is simply not represented. This is the one document whose ground truth
a repeated-group field, or a second section, would genuinely improve.

## What each document is for

Several of these notices exist to make **one** reconciliation outcome reachable, and their ground
truth is what makes that outcome reachable or not. The ones where getting a field wrong destroys the
document's whole purpose:

| Document                                   | The point                                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Interest Notice - Global Amount Only.pdf` | No `Your Share` column. **`amount` absent** — emitting 418,255.00 as `amount` makes a facility total look like this fund's share and the reconciliation compares the wrong two numbers. |
| `Rollover Rate Set Notice.pdf`             | No cash movement at all. **`amount` omitted, not zeroed.**                                                                                                                              |
| `Paydown Notice - Unmapped Facility.pdf`   | **`loanx_id` absent** — an absence of proof of asset identity, not a conflict.                                                                                                          |
| `Commitment Fee Notice - EUR.pdf`          | The only non-USD document; `currency` is the discriminator against a near-miss USD ledger row.                                                                                          |
| `Interest Notice - Other Fund.pdf`         | `Portfolio:` resolves to a different fund than the addressee.                                                                                                                           |
| `Borrowing Cancellation Notice.pdf`        | No effective date, no share, and only a `$` symbol — **no currency code**. All three keys omitted rather than inferred; `USD` from a dollar sign is exactly the guess §4 forbids.       |
| `Agent Notice - Partial Fax Cover.pdf`     | Truncated: a borrower name and nothing else. **No `notice_date` and no `value_date`**, which is the honest truth and drives the mapper's raise-and-dead-letter path on purpose.         |

## Handling

The corpus is synthetic — fictional borrowers, agents and funds, with email addresses on RFC
2606/6761 reserved domains that cannot resolve. It carries no customer data and is safe to upload to
the accelerator.
