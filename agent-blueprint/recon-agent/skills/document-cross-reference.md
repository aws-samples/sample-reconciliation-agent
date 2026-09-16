---
name: document-cross-reference
description: Compare a source document's extracted fields — read off its notice row — against a candidate match, to confirm or refute it with records in the ledger.
tools: [general-ledger___search_ledger, notices___search_notices]
metadata:
  # No trigger: a probe is chosen by the agent when the investigation needs it, not routed to.
  tier: probe
# ⚠️ PAIRED WITH `record-match-review`, and the pair is NOT redundant — do not consolidate them.
# Both declare the same two tools and both compare the same two sides, so they look interchangeable.
# What differs is which side is REQUIRED evidence, and that drives auto-resolution:
#
#   this skill                 | record-match-review
#   the NOTICE is the subject  | the LEDGER entry is the subject
#   notice_corroboration       | notice_corroboration       optional
#     REQUIRED                 |
#   expected_entry_match       | expected_entry_match       REQUIRED
#     OPTIONAL                 |
#   tier probe: the agent      | tier break-type: ROUTED by classify.py
#     ELECTS this when an      |   when side_count == 2
#     item's attributes are    |
#     incomplete               |
#
# Merging them would force one contract on both directions. Requiring both sides makes a document
# with no ledger row — or a sided item with no notice — permanently unresolvable. Making both
# optional lets a case clear the threshold having corroborated NEITHER side. Neither reproduces the
# pair. A merged skill would also need eight distinct required ids, over the six-step ceiling.
result:
  cardinality: single_match
  max_candidates: 1
evidence_steps:
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

When an item's attributes are incomplete, the underlying document's extracted fields are already
**on the notice row** — read them with `notices___search_notices`. There is no separate
document-retrieval call to make here, and no round trip to the extraction pipeline: the ingest hook
read the pipeline's output once, at ingest, and embedded the per-section extraction on the notice.

**As the agent you hold no other route to the document.** The extraction pipeline's output bucket and
its own per-document APIs are not exposed to you by any tool, so do not describe reading them and do
not claim to have. Other parts of the platform legitimately do — the ingest hook reads the output
bucket at ingest (which is how these fields reached the notice row), and the console streams the
source document out of the input bucket for the Documents tab — but neither is a channel you can use.
The notice row is.

1. **Find the notice row.** `search_notices` takes **no id parameter** — its only inputs are
   `counterparty`, `fund`, `reference`, `amount` with `amount_tolerance`, `date_from` / `date_to`,
   `notice_class`, `activity_type`, `require` and `limit`. So query with the most selective hint the item
   gives you (`reference` first, then `counterparty` narrowed by a `date_from` / `date_to` window,
   optionally `amount` with a tolerance). **Nothing on the item names a specific notice**, so no
   returned row arrives pre-confirmed: say which candidate you picked and on what.

   **Use `require` when you are IDENTIFYING a notice, and omit it when you are CORROBORATING one.** A
   filter is soft by default: a notice whose class never extracts the field comes back with that field in
   `fields_unavailable`, which is deliberate and is not a non-match. That is what you want when checking
   whether a candidate agrees with you. It is the wrong default for a lookup by a unique identifier — a
   bare `reference` query also returns every notice that carries no reference at all, burying the one that
   matched. So an identity lookup passes the field name in `require`:

   ```
   search_notices(reference="WIRE-20260302-EVG", require="reference")   # exact: 1 row or none
   search_notices(counterparty="…", activity_type="Rollover")           # soft: absences annotated
   ```

   Never put a field in `require` that the notice class may legitimately not carry — that turns an
   absence you were meant to report into a silent non-match.
   Read the response honestly: an empty `rows` list means searched-and-found-nothing, and
   `truncated: true` means your query was too broad to have seen every candidate — widen or re-narrow
   before concluding anything. A field this notice's class never extracts comes back in
   `fields_unavailable`, which is **not** a non-match.
2. **Read the extracted fields off `idp_sections`.** Each entry is
   `{section_id, classification, page_ids, fields, confidences, mean_confidence, alert_count}`, where
   `fields` is the extraction's `inference_result` **verbatim** and `confidences` is the flattened
   per-field explainability — one record per field, `{field, confidence, threshold, value, extracted}`.
   **Compare each confidence against that record's OWN `threshold`**, never against a single global
   number: the thresholds are per field, and 0.8 and 0.9 both occur live, so one blanket cut-off would
   mis-flag fields in both directions. `alert_count` is the count already below threshold for that
   section.
3. **Two ways this comes back with nothing, and both are reportable rather than inferable.**
   - `idp_sections` is **absent** and `idp_sections_omitted` is set: the extraction was too large to
     keep the row inside its byte budget, so the per-field detail was never stored. Quote
     `idp_sections_omitted` — it names the gap.
   - The document produced **no mappable notice**: the pipeline reached a terminal status but recon
     could not map a notice from it, so all that exists is a tracking-only row with no extracted
     fields. `search_notices` never returns those, so you see an empty `rows` for a document you know
     exists.

   In either case report `notice_corroboration` **unsatisfied**, say which of the two it is, and stop
   there. Never infer, reconstruct or estimate the extracted fields — that is the one failure this
   skill cannot tolerate, because an invented field reads exactly like a corroborated one.

4. Compare the extracted values (effective date, amount, identifier, borrower) against both
   reconciliation sides.

### Facility identifier crosswalk

The source's own identifier is a THIRD namespace, not a variant of the other two. A notice's
`facility_id_source_raw` (an `SL-` prefixed value, typically) is stored verbatim and is never normalised
into a LoanX id: no arithmetic relates them, and the only thing that links them is this table. A source
id with no row here means asset identity is **unavailable** — say so, and cap confidence at MEDIUM.
Inventing the correspondence is how a match gets made against the wrong facility.

> **Where to read `facility_id_source_raw`, `loanx_id`, `cusip` and `isin` on a notice row.** They are
> NOT top-level fields on the rows `search_notices` returns. Look inside `idp_sections[].fields`, which
> holds what the extractor read under the extractor's own key names. A row can have several sections;
> check each. If a name below is absent from every section's `fields`, the document did not carry it —
> treat that as unavailable, exactly as you would a blank top-level field, and never substitute a value
> from the crosswalk table for one the document did not print.

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
   would be attached to. Both live in `idp_sections[].fields` on the notice row, not at the top level —
   see the note under **Facility identifier crosswalk**. That is what `linked_contract_ids` exists to
   record; report it unsatisfied when no section's `fields` carries either.
4. Route to manual review. Do not propose a resolution.
5. **Cap confidence below the top band** no matter how well fund, date and facility align. The
   alignment is real; what is missing is any evidence that cash was due.

How to recognise one: `activity_type` is `Rateset` or `Rollover`; the notice carries a repricing or
rollover table rather than a payment line; and `amount` is usually absent altogether, arriving in
`fields_unavailable`, because there is no payment amount to extract. A notice that bundles a rate set
WITH an interest payment is not this case — it moves cash, and the payment line is the evidence.
