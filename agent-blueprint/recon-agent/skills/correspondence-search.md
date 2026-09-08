---
name: correspondence-search
description: Search the shared mailbox via the Microsoft Graph API for messages that clarify the item by amount, date, or entity.
tools: [correspondence-search___search_correspondence]
metadata:
  # No trigger: a probe is chosen by the agent when the investigation needs it, not routed to.
  tier: probe
---

Search the shared operations mailbox with **`search_correspondence`** to find messages relevant to
this item. Call it with plain arguments:

```json
{
  "query": "<keywords: reference, amount, value date, counterparty/entity>",
  "top": 10
}
```

- `query` is free text — combine the item's reference, amount, value date, and counterparty/entity
  as keywords, e.g. `"CASCADE paydown 1,250,000"`. Do **not** add quotes of your own and do not use
  OData syntax (`$search`, `$top`): the quoting and OData translation are done for you.
- `top` caps the number of returned messages (default 10, capped at 50).
- The mailbox is **not** an argument. It is fixed per deployment (`GRAPH_MAILBOX`), so you cannot —
  and must not try to — point this search at a different mailbox.

Under the hood this reaches Graph `GET /users/{mailboxAddress}/messages` (app-only,
`Mail.Read.Shared`) through the `microsoft-graph` Gateway target. Both backends expose the same
`search_correspondence(query, top?)` signature, so this skill works on either: the container
**Runtime** wraps the Graph op in-process, and the **Harness** calls the `correspondence-search`
Gateway target, which does the same translation server-side. If a skill or note elsewhere mentions
`microsoft-graph___listSharedMailboxMessages`, that is the raw op — never call it directly; its
`$`-prefixed OData arguments are not valid tool-schema property names.

Identify any message that references the payment, break, or expected booking and extract the
clarifying detail (e.g. a corrected reference, an agreed allocation, or a value-date confirmation).

**This is not the same source as the knowledge base's archived email.** `consult-guidance` retrieves
`doc_type=email` documents — a curated, indexed archive of _past_ correspondence, useful as
precedent. This skill reads the **live mailbox**, which is the only place a message that arrived
recently can be found. A KB archive hit does not tell you whether the counterparty has since replied,
so when the question is "what did they say about _this_ item", search the mailbox; the archive
answers "how was a break like this settled before". Neither substitutes for the other.

Always conclude with: (1) a one-paragraph **reasoning** of what the correspondence revealed and
how it resolves or narrows the match, (2) the **evidence_steps** report required by the break-type skill this case was classified under — this skill prescribes no steps of its own, so it adds no entries and removes none — and (3) the
**evidence** list (message subjects/snippets you relied on). These populate the case's ReasoningStep entries, and the evidence_steps outcomes are what determine whether this case can be resolved without a human.
