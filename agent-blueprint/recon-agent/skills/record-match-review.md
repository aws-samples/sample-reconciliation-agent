---
name: record-match-review
description: Compare the two sides' economic attributes (account name, amount, entry type) with tolerance and aggregation to confirm or refute a match.
tools: [general-ledger___search_ledger, notices___search_notices]
metadata:
  tier: break-type
  autonomy: propose-only
# ⚠️ PAIRED WITH `document-cross-reference`, and the pair is NOT redundant — do not consolidate them.
# Both declare the same two tools and both compare the same two sides, so they look interchangeable.
# What differs is which side is REQUIRED evidence, and that drives auto-resolution:
#
#   this skill                 | document-cross-reference
#   the LEDGER entry is the    | the NOTICE is the subject
#   subject                    |
#   expected_entry_match       | expected_entry_match       OPTIONAL
#     REQUIRED                 |
#   notice_corroboration       | notice_corroboration       REQUIRED
#     optional                 |
#   tier break-type: ROUTED    | tier probe: the agent ELECTS it
#     by classify.py when      |   when an item's attributes are
#     side_count == 2          |   incomplete
#
# Merging them would force one contract on both directions. Requiring both sides makes a sided item
# with no notice — or a document with no ledger row — permanently unresolvable. Making both optional
# lets a case clear the threshold having corroborated NEITHER side. Neither reproduces the pair.
# The step ceiling below is the third obstacle: a merged skill needs eight distinct required ids.
result:
  # A payment can plausibly settle several expected entries, so this skill returns a ranked set and
  # the analyst picks. Narrowing to one candidate here would hide the ambiguity rather than resolve it.
  cardinality: ranked_set
  max_candidates: 5
evidence_steps:
  - id: fund_alias_match
    required: true
    description: Resolve the counterparty's fund label to the internal fund code using the crosswalk in this skill.
  - id: expected_entry_match
    required: true
    description: Find the candidate expected-side entry with general-ledger___search_ledger.
  - id: amount_within_tolerance
    required: true
    description: Confirm the amounts agree within the stated tolerance, or state the residual.
  - id: entry_direction
    required: true
    description: Confirm the entry type/direction is consistent with the payment direction.
  # ⚠️ SIX required steps, and six is the ceiling. The score is satisfied_required/prescribed_required
  # and auto-resolve is gated on it, so a SEVENTH required step would make 6/7 = 0.857 clear a 0.85
  # threshold — auto-resolve on incomplete evidence, arrived at by adding rigour. 5/6 = 0.833 does not.
  - id: asset_identity_match
    required: true
    description: Corroborate the facility or security identifier on BOTH sides, or state that no crosswalk links them.
  - id: fund_level_amount_available
    required: true
    description: Confirm the notice carries a fund-level amount, or state that only a facility-wide total exists.
  - id: notice_corroboration
    required: false
    description: Corroborate the candidate against an extracted counterparty notice with notices___search_notices.
  - id: prior_lesson
    required: false
    description: Check whether a prior lesson for this counterparty or fund changes the conclusion.
---

Confirm or refute a match by comparing the **economic identity** of the two reconciliation
sides — never the document filename or an incidental reference/identifier (a ledger reference is
a wire/transaction code, not the uploaded file name). Compare these three attributes:

1. **Account name** — the borrower / counterparty. The ledger side carries it in the `borrower`
   column; the document side carries it as the extracted counterparty name. They should name the
   same entity (allow for casing and legal-suffix variants, e.g. "INC." vs "Inc").
2. **Amount** — apply the configured tolerance band to the numeric amounts, and account for
   **aggregation**: several ledger records on one side may sum to a single amount on the other
   (e.g. one wire settling multiple facilities). Compare component-to-component and
   sum-to-total.

   **Which amount.** A notice may carry a facility-wide total, a fund-level share, or both — they are
   separate fields and they are not interchangeable:

   - Compare the **fund-level** amount. A facility-wide total covers every fund on the facility and is
     never valid for validating one of them.
   - When only a total exists, the notice's `amount_type` reads `GLOBAL_ONLY` and its `amount` comes
     back in `fields_unavailable`. Report `fund_level_amount_available` as **not satisfied**, say
     fund-level amount validation was unavailable, and cap your confidence at MEDIUM. Do not compute a
     share yourself — the allocation is the agent bank's to state, not yours to infer.
   - For **fee** activity compare the fee amount, not the payment amount.

   Match on fund **and** date **and** activity. Never on facility alone: one facility legitimately
   issues separate notices for several funds, so a facility-only match can be confidently wrong.

   Compare ISO dates, never a raw printed date string — a notice's `notice_date_source_raw` is kept for
   audit and is not normalised.

3. **Asset identity** — the facility or security identifier. The ledger side carries `loanx_id`,
   `cusip` and `isin`; the notice side carries those plus `facility_id_source_raw`, which is the
   source's own identifier in its own namespace and is **not** interchangeable with a LoanX id. Resolve
   through the crosswalk in `document-cross-reference`. If no crosswalk entry links them, that is
   asset identity **unavailable** — an absence of proof, which caps confidence at MEDIUM. It is not a
   mismatch. Two identifiers that are both present and disagree IS a mismatch, and disqualifies.

4. **Entry type** — the CREDIT/DEBIT direction must agree. A cash-receipt/settlement notice
   (interest, paydown, principal, fee, rate-set, borrowing draw) is a **CREDIT** to the cash
   account; a cancellation/withdrawal/reversal notice is a **DEBIT**. A direction mismatch
   refutes the match even when the amount is within tolerance.

**Corroborating against the actual side.** `notices___search_notices` queries counterparty notices
that have already been extracted. It is a _reference_ lookup: a notice is evidence about an item,
never the thing that created it. Pass the hints you actually have (`counterparty`, `fund`,
`reference`, `amount` with `amount_tolerance`) and read `fields_unavailable` in the response — a
field listed there was not extracted for those notices, which is not the same as not matching.

Query the ledger by borrower (and amount range when helpful) to pull candidate rows, then reason
over the three attributes above. Note exact matches, near-matches within tolerance, aggregation
relationships, and any mismatches.

Always conclude with: (1) a one-paragraph **reasoning** of which attributes matched, which
differed, and by how much, (2) an **evidence_steps** entry for EVERY step in this skill's `evidence_steps` front matter — `satisfied: true` only when that step's tool call returned data answering it, never because you reasoned around it — and (3) the **evidence** list
(the specific attribute values you compared — account name, amounts, entry type). These populate the case's ReasoningStep entries, and the evidence_steps outcomes are what determine whether this case can be resolved without a human.

<!-- fund-alias-table:start -->

### Fund / portfolio alias table

Counterparties label the same fund differently from the book of record. Resolve the label you were
given to the **internal fund code** before comparing anything else; an unresolved alias is a failed
`fund_alias_match` step, not a licence to guess.

Note on vocabulary: a counterparty notice calls this dimension the **portfolio**. It is the same thing
as the fund on the ledger side, and this table is the only mapping between them — there is no separate
portfolio field to look up.

| Internal fund code | Book-of-record account label | Aliases seen on counterparty notices          |
| ------------------ | ---------------------------- | --------------------------------------------- |
| `FUND-DL-I`        | `Direct Lending Fund I`      | `DL Fund I`, `DL-1`, `Direct Lending I LP`    |
| `FUND-DL-II`       | `Direct Lending Fund II`     | `DL Fund II`, `DL-2`, `Direct Lending II LP`  |
| `FUND-SCF`         | `Senior Credit Fund`         | `Senior Credit`, `SCF`, `Sr Credit Fund LP`   |
| `FUND-OPP`         | `Opportunistic Credit Fund`  | `Opp Credit`, `OCF`, `Opportunistic Cr. Fund` |

Matching rules, in order:

1. Case-insensitive exact match against any alias or the account label.
2. Strip legal suffixes (`LP`, `L.P.`, `LLC`, `Ltd`) and punctuation, then retry step 1.
3. No match after both → report `fund_alias_match` as **not satisfied** and say which label failed.
   Do not fall back to the single fund that happens to have the most entries.

<!-- fund-alias-table:end -->
