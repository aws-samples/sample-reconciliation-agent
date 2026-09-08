---
name: document-cross-reference
description: Retrieve and compare fields from a source document to confirm or refute a candidate match with records in the ledger.
tools:
  [
    document-extraction___IDPTools___get_results,
    general-ledger___search_ledger,
    notices___search_notices,
  ]
metadata:
  # No trigger: a probe is chosen by the agent when the investigation needs it, not routed to.
  tier: probe
result:
  cardinality: single_match
  max_candidates: 1
evidence_steps:
  # MIRROR of record-match-review: there the ledger entry is the subject of the comparison and the
  # notice corroborates it; here the notice IS the subject, so it is required and the book-of-record
  # lookup becomes the optional corroboration. Same two sides, opposite direction.
  - id: notice_corroboration
    required: true
    description: Retrieve the extracted notice for this document with notices___search_notices.
  - id: identifier_normalized
    required: true
    description: Normalize every facility identifier to the canonical form in the crosswalk below.
  # Five required steps. See the ceiling note in record-match-review: six is the maximum any skill may
  # declare, because a seventh makes incomplete evidence clear the auto-resolve threshold.
  - id: asset_identity_match
    required: true
    description: Corroborate the facility or security identifier on both sides, or state that no crosswalk links them.
  - id: fund_level_amount_available
    required: true
    description: Confirm the document carries a fund-level amount, or state that only a facility-wide total exists.
  - id: linked_contract_ids
    required: true
    description: For a rateset or rollover, surface contract_id and new_contract_id as evidence of the linked event.
  - id: expected_entry_match
    required: false
    description: Corroborate the identifier against the book of record via general-ledger___search_ledger.
---

When an item's attributes are incomplete, retrieve the underlying document's extracted fields
from IDP via the **document-extraction** MCP tool. Never read IDP's S3 output or AppSync
directly — the only channel to IDP is this MCP tool.

1. Read the IDP backlink from the item's `source_refs`: the `idp:documentId=<id>` entry (and
   `idp:section=<section_id>:<uri>` if you need a specific section). The `<id>` value is the
   document id you pass to `get_results` below.
2. Call the document-extraction MCP tool with the **`document_id`** parameter:
   `document-extraction___IDPTools___get_results(document_id=<id>)` to fetch the full
   `inference_result` fields and their `explainability_info` / `confidence_threshold_alerts`
   confidence. **Always use `document_id` for a single document — never `batch_id`.** `batch_id`
   routes to the multi-document batch path (which fails for a single doc), and the parameter is
   `document_id` (snake_case), not `documentId`.
3. If the item has **no** `idp:` backlink (e.g. it arrived via the structured API), use the
   MCP `search` tool (natural-language query by amount / value date / counterparty) to locate
   the corroborating document, then `document-extraction___IDPTools___get_results(document_id=<id>)`
   on the best match.
4. Compare the extracted values (effective date, amount, identifier, borrower) against both
   reconciliation sides.

### Facility identifier crosswalk

The source's own identifier is a THIRD namespace, not a variant of the other two. A notice's
`facility_id_source_raw` (an `SL-` prefixed value, typically) is stored verbatim and is never normalised
into a LoanX id: no arithmetic relates them, and the only thing that links them is this table. A source
id with no row here means asset identity is **unavailable** — say so, and cap confidence at MEDIUM.
Inventing the correspondence is how a match gets made against the wrong facility.

One facility carries up to four identifiers, and counterparty documents pick whichever one they like.
Normalize to the **canonical LoanX ID** first; everything else keys off it.

**Canonical LoanX ID form:** `LX` + 7 digits, no separator — e.g. `LX0041872`.

| Variant seen in documents  | Normalization                      |
| -------------------------- | ---------------------------------- |
| `LX-0041872`, `LX 0041872` | Strip the separator.               |
| `41872`, `0041872`         | Left-pad to 7 digits, prefix `LX`. |
| `LOANX:0041872`            | Strip the `LOANX:` prefix.         |

| Canonical LoanX ID | Facility (book of record)             | CUSIP      | ISIN          |
| ------------------ | ------------------------------------- | ---------- | ------------- |
| `LX0041872`        | `CINDERMOOR LOGISTICS TL-A $160MM`    | `12345AB6` | `US12345AB67` |
| `LX0041873`        | `CINDERMOOR LOGISTICS TL-B $250MM`    | `12345AB7` | `US12345AB75` |
| `LX0052901`        | `MISTFELL FOODS INITIAL TERM LOANS`   | `23456CD7` | `US23456CD78` |
| `LX0063110`        | `NORTHWIND MANUFACTURING TERM LOAN A` | `34567EF8` | `US34567EF80` |

A document identifier that normalizes to nothing in this table is an **unsatisfied**
`identifier_normalized` step. Report it as such; never match on the facility's display name alone,
because `TL-A` and `TL-B` differ by one character and settle different amounts.

Always conclude with: (1) a one-paragraph **reasoning** of which extracted fields corroborate
or conflict with the sides, (2) an **evidence_steps** entry for EVERY step in this skill's `evidence_steps` front matter — `satisfied: true` only when that step's tool call returned data answering it, never because you reasoned around it — and (3) the **evidence** list (the extracted field values you
used). These populate the case's ReasoningStep entries, and the evidence_steps outcomes are what determine whether this case can be resolved without a human.

## Rateset and rollover notices: no standalone cash

A rateset or rollover notice records that a loan's rate was reset or its contract rolled. **It does not
by itself prove that any cash moved**, and treating one as a payment confirmation is the most consistent
way to reach a confident wrong answer on this skill.

When the only candidate for an item is a rateset or rollover notice:

1. **Do not call it a confirmed cash match.** Whatever else aligns, the notice does not evidence a
   payment.
2. Surface this conclusion in your reasoning, in these words: _notice type indicates no standalone cash
   is expected — confirm whether the break relates to accrual, timing, or a linked interest event._
3. Surface `contract_id` and `new_contract_id`, which identify the linked event a real cash movement
   would be attached to. That is what `linked_contract_ids` exists to record; report it unsatisfied when
   the notice carries neither.
4. Route to manual review. Do not propose a resolution.
5. **Cap confidence below the top band** no matter how well fund, date and facility align. The
   alignment is real; what is missing is any evidence that cash was due.

How to recognise one: `activity_type` is `Rateset` or `Rollover`; the notice carries a repricing or
rollover table rather than a payment line; and `amount_type` is often `UNKNOWN` because there is no
payment amount to extract. A notice that bundles a rate set WITH an interest payment is not this case —
it moves cash, and the payment line is the evidence.
