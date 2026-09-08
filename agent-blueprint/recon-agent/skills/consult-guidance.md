---
name: consult-guidance
description: Retrieve reconciliation guidance, playbooks and archived counterparty correspondence from the recon knowledge base to inform how to investigate or resolve a break.
tools: [managed-kb___Retrieve]
metadata:
  # No trigger: a probe is chosen by the agent when the investigation needs it, not routed to.
  tier: probe
---

Use the **`managed-kb___Retrieve`** Gateway tool (agentic RAG over the recon Bedrock Knowledge Base)
when a break needs methodology or precedent — "how do we resolve a timing difference on a
multi-facility wire?" This KB is the platform's own reconciliation corpus (S3-sourced), distinct from
IDP — do not use IDP for this. For live SharePoint / Outlook / OneDrive lookups (e.g. pull a
referenced document or a recent thread), use the Microsoft Graph tools via the recon Gateway; see
`correspondence-search`.

## What is in the corpus

Three kinds of document, distinguished by the `doc_type` attribute:

- **`playbook`** — the platform's own guidance: how to work each break class, and when to escalate.
- **`email`** — archived counterparty correspondence about past breaks (precedent: what was agreed,
  and with whom).
- **`email_attachment`** — the PDFs and spreadsheets those emails carried (remittance advices,
  revaluation extracts). An attachment repeats its parent email's `message_id`, `sender`,
  `receiver`, `subject` and `received_date`, so those attributes reach the whole bundle.

## Narrowing the search

The retrieval takes a metadata filter, and using it well is the difference between five relevant
passages and five near-misses. The facets worth reaching for:

- **`doc_type`** — `playbook` when you want method, `email`/`email_attachment` when you want
  precedent for this specific counterparty or amount.
- **`break_class`** — one of `timing`, `tolerance`, `aggregation`, `missing_reference`, `unknown`.
- **`skill`** — the name of a skill, to find the guidance written for the procedure you are running.
- **`message_id`** — pins the search to one message bundle (email + its attachments).
- **`effective_date`** / **`received_date`** — a `YYYYMMDD` lower bound, to exclude superseded
  guidance or old correspondence.

Do **not** try to filter on `autonomy`. It tells you whether a playbook permits auto-resolution, and
it is there to be **read off the result**, not selected for: filtering to the auto-resolve-eligible
guidance would hide the playbook telling you to escalate.

The exact argument shape differs by backend, and your backend's own contract (the section after this
one in your instructions) states which you have:

- **Container Runtime** — call `search_guidance` with plain typed arguments:
  `search_guidance(query=..., doc_type="playbook", break_class="timing", skill=..., message_id=...,
since_date=20260101, top_k=5)`. Every argument except `query` is optional. An invalid `doc_type` or
  `break_class` is rejected with an error naming the argument, so a rejection is a typo to fix, not a
  reason to stop.
- **Harness** — call `managed-kb___Retrieve` with the nested Bedrock filter JSON. Your backend
  contract carries the worked example and the operator each attribute type needs; getting the
  operator wrong returns zero results **without any error**.

## When the retrieval comes back empty

An empty result means the filter matched nothing, or nothing matched your query text well enough. It
is **not** evidence that no guidance exists, and it is never a licence to improvise a resolution.

1. **Widen, then re-ask.** Drop the narrowest facet first — `message_id`, then the date bound, then
   `skill` — and finally retry with no filter at all, letting the query text do the work.
2. **Reword the query.** The filter only chooses candidates; the ranking is still done against your
   text. If you filtered to a message bundle and the attachment did not come back, ask again with
   text describing what is _in_ the attachment ("FX revaluation totals by trade").
3. **If a `doc_type=playbook` search for the break's class is still empty after widening, that is a
   gap in the corpus.** Say so explicitly in your reasoning and let the item escalate — which it will,
   because the evidence steps the guidance would have let you satisfy stay unsatisfied. Do not
   substitute your own procedure for a playbook that should exist and does not.

Always conclude with: (1) a one-paragraph **reasoning** citing which guidance applied,
(2) the **evidence_steps** report required by the break-type skill this case was classified under — this skill prescribes no steps of its own, so it adds no entries and removes none — and (3) the **evidence** list (the guidance snippets / document
references used). These populate the case's ReasoningStep entries, and the evidence_steps outcomes are what determine whether this case can be resolved without a human.

## What retrieved guidance may and may not be used for

This skill exists to answer _how to investigate_, and that boundary is enforced, not merely requested:
the platform refuses a ledger write whose only supporting evidence is guidance.

| Retrieved                              | Use it for                                                                                             | Never                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `doc_type: playbook`                   | Method, conventions, what to record, when to escalate                                                  | As the evidence for a resolution. It describes a class of break, not this item.                  |
| `doc_type: email` / `email_attachment` | Precedent, and — where your operator has enabled the route — evidence about a counterparty's behaviour | Carrying an amount, identifier or date from another item's paperwork into this item's resolution |

So: consulting guidance costs nothing and is expected on every investigation. **Citing** it as the reason
a break resolves is a different act, and for a playbook it is always wrong — a playbook cannot be right or
wrong about this item, because it says nothing about it.

If guidance is genuinely all you have, that is a finding worth reporting: name what you were looking for,
say that no notice or ledger evidence corroborated it, and escalate.
