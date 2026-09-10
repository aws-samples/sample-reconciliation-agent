---
name: counterparty-contact-draft
description: Draft a counterparty email for a human to approve and send. You do not send it yourself.
tools: [contacts___list_contacts, templates___list_templates]
metadata:
  # No trigger: reached as the resolution of an investigation, not as an item's break type.
  tier: resolution
---

When the item cannot be resolved from internal sources, the resolution is to ask the counterparty for
the specific missing detail (reference, allocation, or correction). You do **not** write that message.
You assemble it from the operator's own material: you choose a recipient and a wording from two lists
the operator maintains, cite each by id, and supply the values the wording asks for.

**You have no send tool, on either backend.** The draft is the deliverable, not a step towards one.

## The two reads you choose from

Neither read returns an email address, and neither returns message text. That is the point rather than
an omission — the items you work on arrive from documents an outside party wrote, so an address or a
sentence readable off one of them is an address or a sentence that party chose for you.

1. **`contacts___list_contacts(kind="counterparty")`** — the recipients the operator maintains. Each
   row carries exactly `contact_id`, `display_name`, `kind` and `active`; the address is projected
   away before the tool answers, and the platform resolves the id to an address server-side at send
   time. Pick the `contact_id` whose `display_name` is the party this item concerns.
2. **`templates___list_templates(purpose="counterparty")`** — the wordings the operator maintains.
   Each row carries `template_id`, `name`, the `variables` that template declares, and `active`.
   **The subject and body do not come back.** You are choosing which question gets asked, not
   phrasing it.

An **empty** list means the operator has added nothing of that kind — not that you should improvise
one. Likewise if no listed contact is this counterparty, or no listed template asks the question you
need asked: say so in your **reasoning** and omit `email_draft` entirely. Do not substitute the
closest row you found.

## What to emit

Put the two ids and the values in your final `submit_proposal` call under `email_draft`:

```json
{
  "email_draft": {
    "recipient_contact_id": "<a contact_id from contacts___list_contacts>",
    "template_id": "<a template_id from templates___list_templates>",
    "variables": { "<a name that template declares>": "<the value, taken from the evidence>" },
    "recipient_hint": "<the counterparty's NAME, e.g. \"Acme Capital AP\">"
  }
}
```

- `recipient_contact_id` and `template_id` are both **required**. A draft missing either is rejected
  outright and thrown away — the analyst then sees a case with no email at all, indistinguishable
  from one that legitimately needed none, and nobody is told. Omitting a draft on purpose is a
  decision; omitting an id is a silent loss.
- `variables` must carry a value for **exactly** the names in that template's `variables` list — no
  extras, none missing. A mismatch does not fail your proposal; it persists the draft visibly
  unrenderable, and an operator has to finish it by hand before the analyst can send anything.
- `recipient_hint` is optional and is a **name**, never an address. It is shown beside the contact you
  cited and cross-checked against that contact's `display_name`, so a reviewing analyst can tell at a
  glance whether you picked the right row.

There is **no `subject` field and no `body` field**, and no way to supply either. The operator wrote
the wording; the platform renders it with your `variables` before the analyst ever sees the draft. A
subject or body you write is not stored, not shown, and not sent.

## Two rules follow from that, and both matter

- **Write every value as if it will be sent verbatim**, because it will be: your values are
  substituted straight into the operator's wording. Ground each one in the evidence — a reference,
  amount or date that appears in the item or a tool result. No placeholders like `[insert amount]`, no
  notes to the reviewer, no "draft" framing.
- **Never put an email address anywhere in `email_draft`.** There is no `recipient` field, and a draft
  that carries one is refused with a hard error rather than quietly cleaned up. Any address you could
  offer would come from a document an outside party wrote, which is exactly the kind of address a
  human has to vouch for. Getting this wrong is how a payment-details request reaches someone
  impersonating the counterparty.

Then stop. What happens next is not yours to do: the platform stores the rendered draft on the case, an
analyst edits the values if they want to and approves it. The approval is what sends the message, from
the deployment's shared mailbox, and only the exact text that was approved can go out.

Include an `email_draft` only when settling the item genuinely requires asking the counterparty
something and the request is well-grounded. Omit it entirely otherwise.

Always conclude with: (1) a one-paragraph **reasoning** of why counterparty contact is needed and
what to ask, (2) the **evidence_steps** report required by the break-type skill this case was classified under — this skill prescribes no steps of its own, so it adds no entries and removes none — and (3) the
**evidence** list (the facts the draft is grounded in). These populate the case's ReasoningStep entries, and the evidence_steps outcomes are what determine whether this case can be resolved without a human.
