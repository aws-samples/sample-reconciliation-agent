# IDP Extraction Requirements — Loan Notices

**Audience:** whoever configures the document-processing (IDP) solution. This is the contract the
reconciliation platform reads. It is not a description of what IDP does today.

**Why it is written down.** The reconciliation hook reads extracted values out of the IDP result by
**literal key name** (`backend/idp_hook/mapper.py`). An extraction that finds the right value and emits
it under a different key produces a notice with that field reported as _unavailable_ — which the agent
treats as "this notice class does not carry that field", not as an error. Nothing anywhere reports the
mismatch. So the key names below are the contract, and
`tests/input_corpus/test_extraction_requirements.py` asserts this document and the mapper agree in both
directions.

**Sample documents.** Every class below has at least one synthetic sample under `data/input/`. They are
fake but structurally faithful to real agent-bank notices — same field labels, same section headings,
same tabular layout. Use them to build and test the extraction configuration.

---

## 1. Document classes

The value in the first column is what the extraction must report as the section's `classification`. It
lands on the notice as `notice_class`.

| Class (`classification`)      | Folder                               | Sample file(s)                                                                                   |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `borrowing_notice`            | `01-borrowing-notices/`              | `Borrowing Notice.pdf`                                                                           |
| `interest_rate_set_notice`    | `02-interest-and-rate-set-notices/`  | `Interest Payment & Rate Set Notice.pdf`                                                         |
| `commitment_fee_notice`       | `02-interest-and-rate-set-notices/`  | `Commitment Fee Notice.pdf`                                                                      |
| `paydown_notice`              | `03-paydown-principal-notices/`      | `Mandatory Paydown Notice.pdf`, `Optional Paydown Notice.pdf`, `Paydown and Interest Notice.pdf` |
| `cancellation_notice`         | `04-cancellation-notices/`           | `Borrowing Cancellation Notice.pdf`                                                              |
| `consolidated_payment_advice` | `05-multi-facility-aggregated-wire/` | `One Wire for Multiple Facilities - Consolidated Payment Advice.pdf`                             |
| `activity_memo`               | `05-multi-facility-aggregated-wire/` | `One Wire for Multiple Facilities - Activity Memo.pdf`                                           |
| `summary_statement`           | `05-multi-facility-aggregated-wire/` | `One Wire for Multiple Facilities - Summary Statement.pdf`                                       |
| `rollover_rate_set_notice` | `02-interest-and-rate-set-notices/` | `Rollover Rate Set Notice.pdf` |
| `incomplete_notice` | `06-incomplete-notices/` | `Agent Notice - Partial Fax Cover.pdf` |

`rollover_rate_set_notice` is distinct from `interest_rate_set_notice` on purpose: a rate set bundled
with an interest payment moves cash, and a rollover on its own does not. Classifying them together would
make the difference invisible, and it is the difference that decides whether cash was expected at all.

`incomplete_notice` covers a document that arrived truncated or unreadable — a partial fax, a scan with
missing pages. Classify it as such rather than guessing at the class it would have been: a wrong class
with confident fields is worse than an honest "this document is incomplete".

An unrecognised document must still classify — report `unclassified` rather than failing the
extraction. The platform has a path for an unclassified notice; it has no path for a missing one.

## 2. Field keys

Emitted inside each section's `fields` map. `Required` means the platform cannot use the notice for
its purpose without it, not that the extraction should fail — see §3.

| Field key      | Type    | Required for                                           | Example (from the sample)      | Notice field   |
| -------------- | ------- | ------------------------------------------------------ | ------------------------------ | -------------- |
| `notice_date`  | date    | **every class**                                        | `2026-01-26`                   | `notice_date`  |
| `value_date`   | date    | accepted as a fallback for `notice_date`               | `2026-01-26`                   | `notice_date`  |
| `counterparty` | string  | **every class**                                        | `NORTHWIND MANUFACTURING LLC`  | `counterparty` |
| `borrower`     | string  | accepted as a fallback for `counterparty`              | `NORTHWIND MANUFACTURING LLC`  | `counterparty` |
| `fund`         | string  | every class where the notice names a fund or portfolio | `DL Fund II`                   | `fund`         |
| `facility`     | string  | every class that names a facility                      | `NORTHWIND TERM LOAN A $475MM` | `facility`     |
| `reference`    | string  | every class carrying a wire or transaction reference   | `WIRE-20260302-EVG`            | `reference`    |
| `amount`       | decimal | see §4 — the **fund-attributable** amount only         | `1512361.04`                   | `amount`       |
| `currency`     | string  | every class stating a currency                         | `USD`                          | `currency`     |
| `activity_type` | string | every class — the source's own word for what the notice reports | `Interest` | `activity_type` |
| `global_amount` | decimal | every class printing a facility-wide total (§5) | `3939077.64` | `global_amount` |
| `fee_amount` | decimal | `commitment_fee_notice` | `446.67` | `fee_amount` |
| `fee_percentage` | decimal | `commitment_fee_notice` | `0.375` | `fee_percentage` |
| `facility_id_source_raw` | string | every class naming a facility id — **verbatim**, prefix and all | `SL-204811` | `facility_id_source_raw` |
| `loanx_id` | string | every class printing `LoanXid:` | `LX204811XXXX1` | `loanx_id` |
| `cusip` | string | the **facility**-level CUSIP, not the deal-level one | `SYN00031A` | `cusip` |
| `isin` | string | the **facility**-level ISIN, not the deal-level one | `US12345AB67` | `isin` |
| `agent_bank` | string | every class — the sending institution | `Meridian Agency Services LLC` | `agent_bank` |
| `agent_contact_name` | string | where the notice carries an `ATTN:` line or contact block | `Dana Whitfield` | `agent_contact_name` |
| `agent_email` | string | where the notice carries a sender or contact address | `loan.ops@meridian-agent.example` | `agent_email` |
| `agent_telephone` | string | where the notice carries a contact number | `+1-555-0100` | `agent_telephone` |
| `contract_id` | string | `interest_rate_set_notice` and rollover notices | `CT-204811-A` | `contract_id` |
| `new_contract_id` | string | `interest_rate_set_notice` and rollover notices | `CT-204811-B` | `new_contract_id` |
| `notice_comment` | string | where the notice carries free-text remarks | `only interest notice` | `notice_comment` |
| `notice_date_source_raw` | string | every class — the date **exactly as printed**, before normalisation | `26-Jan-2026` | `notice_date_source_raw` |

⚠️ **`notice_date` and `counterparty` are the two that break retrieval outright.** They are the range
key and hash key of the notice table's primary index. The mapper **raises** when neither `notice_date`
nor `value_date` is extracted, so the document is retried and then dead-lettered. An absent
`counterparty` is stored as the literal `unknown`, which keeps the notice retrievable by id but removes
it from the agent's main query path. Prioritise these two above everything else in this document.

## 3. Section-level keys

Reported on the section itself, not inside `fields`.

| Section key                 | Type    | Purpose                                                           |
| --------------------------- | ------- | ----------------------------------------------------------------- |
| `classification`            | string  | One of §1's class values, or `unclassified`.                      |
| `classification_confidence` | decimal | 0–1. Stored as the notice's `extraction_confidence`.              |
| `confidence_alert_count`    | integer | **Required, and required to be present even when zero** — see §6. |

## 4. Absence is a signal, not a failure

The platform distinguishes three states per field, and collapsing them loses information it acts on:

| State                        | How to emit it            | How the platform reads it                     |
| ---------------------------- | ------------------------- | --------------------------------------------- |
| Extracted, has a value       | the key, with the value   | usable evidence                               |
| Extracted, genuinely blank   | the key, with `""`        | the document says nothing here                |
| Not applicable to this class | **omit the key entirely** | reported to the agent as `fields_unavailable` |

**Do not emit a placeholder, a zero or a dash for a field this class does not carry.** A rollover
notice has no cash amount; a fax cover page has no fund; a summary statement may have no wire
reference. Omitting the key is correct and expected in each case.

## 5. The two amount columns are two fields

**This is the single most consequential instruction in this document.**

Agent-bank notices print a facility-wide total and the recipient's share side by side, typically
labelled `Global Amount` and `Your Share`:

```
Description            Global Amount      Your Share
Term SOFR Term         3,939,077.64         9,822.30
```

- `Your Share` → `amount`. This is the **fund-attributable** amount, and the only one valid for
  fund-level validation.
- `Global Amount` → a separate key (see the roadmap note below). It must **never** be emitted as
  `amount`.

If only a global total is present, **omit `amount`** and emit the global figure under its own key. The
platform then marks fund-level amount validation as unavailable, which is a correct and useful outcome.
Emitting the global figure as `amount` instead makes a notice-wide total look like this fund's amount,
and the reconciliation silently compares the wrong two numbers.

## 6. Confidence signals

- `classification_confidence` on every section.
- `confidence_alert_count` — the count of extracted fields the pipeline scored below their own
  confidence threshold. **Emit it even when it is zero.** The platform's write guard distinguishes
  "resolved to zero" (a clean extraction) from "the attribute is absent" (a guard that could not be
  evaluated) and refuses the second. An omitted count therefore blocks downstream writes rather than
  passing them.
- If per-field confidence is available, emit it per field; the platform surfaces it in the analyst's
  evidence trail.

## 7. What the platform does not need

Stated so no one builds it:

- **No case creation, and no writes to any reconciliation table.** An extracted document is _evidence
  about_ a reconciliation item, never the thing that creates one.
- **No callbacks** beyond the completion event the hook already consumes.
- **No delivery-route metadata.** The platform does not record how a document arrived.
- The only two channels between the two solutions are the completion-event hook and the IDP MCP tool.
  Nothing else should be added.

---

## Roadmap — keys not yet read by the platform

Specified so one extraction configuration covers this release and the next. The parity test does not
require them.

| Field key             | Type   | Source on the document                                                                                                                                                                       |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription_status` | string | Not on the document at all — feed reference data. Listed so its ABSENCE is understood as correct rather than as a gap: a blank subscription status is the signal that routing needs a human. |
| `source_status_raw`   | string | Also not on the document — the feed's own processing status (`New` / `Reviewed`).                                                                                                                 |
