---
name: ledger-status-resolution
description: Resolve a confirmed break by proposing a ledger status update, executed via the Policy-gated set-draw-status___set_draw_status write.
tools: [set-draw-status___set_draw_status]
metadata:
  tier: break-type
  # This skill drives a Policy-gated ledger WRITE. The rule "do not write until the prescribed
  # evidence is satisfied" is enforced at the gateway by AgentCore Policy and by the
  # evidence-completeness score (backend/recon_core/confidence.py), NOT by anything in this file.
  autonomy: confidence-gated
result:
  # A status update targets exactly one ledger record. Two candidates means the match is unresolved,
  # which is a record-match-review outcome, not a resolution.
  cardinality: single_match
  max_candidates: 1
evidence_steps:
  - id: break_cause_stated
    required: true
    description: State the specific cause of the break, not just that the sides disagree.
  - id: target_entry_identified
    required: true
    description: Identify the single ledger entry whose status is to change, by its entry reference.
  - id: status_transition_valid
    required: true
    description: Confirm the requested status is a legal transition from the entry's current status.
  - id: agent_contact_available
    required: true
    description: Identify the agent contact on the matched notice, or state that the notice carries none.
  - id: notice_corroboration
    required: false
    description: Cite the extracted counterparty notice that supports the transition, if one exists.
---

Once the investigation confirms how a break should be resolved, the resolution is recorded as a
draw/ledger **status update**. This is the terminal action for most classes — it applies across
break patterns, so it is not a classification type the classifier picks; it is the resolution
step the agent proposes after its read-only investigation.

The write goes through the **`set-draw-status___set_draw_status`** Gateway tool, which records the mutation in the
GL **status overlay** (the authoritative general ledger stays read-only; `general-ledger___search_ledger` merges
the overlay onto its results). Two hard guardrails apply — do not try to work around either:

1. **Status allowlist.** The only proposable statuses are `Confirmed`, `Cancelled`, `OnHold`,
   and `Amended`. Any other value is rejected by both the model schema and the Lambda.
2. **Reference provenance.** You do NOT supply the ledger `reference`. It is derived from your
   recorded `general-ledger___search_ledger` results: exactly **one** distinct matched reference ⇒ that reference
   is used; **zero or more than one** ⇒ there is nothing safe to write, so no status update is
   proposed (escalate for human handling instead). This prevents a model from redirecting a
   write to an arbitrary record.

The write is **confidence-gated by AgentCore Policy**. The agent never calls `set-draw-status___set_draw_status`
directly — it emits an `execute` proposal with the intended status/reason, and the worker (or
the human-approve path) performs the Policy-gated write only when the computed evidence-completeness
confidence clears the admin threshold; below threshold the status update is queued in the
proposal for human approval.

Tool: `set-draw-status___set_draw_status(reference, status, reason?, confidence)` → writes one idempotent row to
the GL status overlay. Both `reference` and `confidence` are supplied by the worker, not the model:
`confidence` is the computed evidence-completeness score the Policy gate compares, so there is no
number here for you to author.

Always conclude with: (1) a one-paragraph **reasoning** of why this status resolves the break
and which evidence supports it, (2) an **evidence_steps** entry for EVERY step in this skill's `evidence_steps` front matter — `satisfied: true` only when that step's tool call returned data answering it, never because you reasoned around it — and
(3) the **evidence** list (the `general-ledger___search_ledger` reference and the corroborating values). These populate the case's ReasoningStep entries, and the evidence_steps outcomes are what determine whether this case can be resolved without a human.

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

## Expected cash that has not arrived: wait, or chase

A booking on the expected side with no matching cash is not automatically a problem. It becomes one only
after the time the counterparty is allowed. Decide in this order:

1. **Are the required sources complete for this fund and date?** If a feed for that day has not landed,
   the item is _awaiting source data_. Do not chase anyone — there is no evidence yet that anything is
   wrong, and an inquiry sent now is one the counterparty cannot answer.
2. **Is the expected date still inside the configured grace period?** If so the item is _within the
   timing window_: state the expected date, state that the window has not expired, and propose no
   outreach. Cash expected today is not cash that is late.
3. **Past the grace period?** Now it is a **cash chase**. Name the party to contact and why:
   - no evidence the cash was ever sent → the **agent bank**, using the contact on the matched notice
     (`agent_contact_name`, `agent_email`, `agent_telephone`). That contact is authoritative for this
     facility, which is why it travels on the notice rather than coming from a directory.
   - evidence it was sent but not applied → the **custodian**, using the configured contact.
   - the notice is invalid or absent → manual review, not an inquiry.

The grace period is **configuration**, not a number to hard-code and not something the corpus encodes.
Read it from the item's context; if you cannot establish it, say so and treat the item as within the
window rather than assuming it has expired. Being early with a chase costs the operator credibility with
the counterparty; being late costs a day.

**No outreach is ever sent automatically.** Everything above produces a proposal for a human to approve.
