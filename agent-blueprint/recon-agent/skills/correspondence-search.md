---
name: correspondence-search
description: Search the shared mailbox via the Microsoft Graph API for messages that clarify the item by amount, date, or entity.
tools: [correspondence-search___search_correspondence]
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

Always conclude with: (1) a one-paragraph **reasoning** of what the correspondence revealed and
how it resolves or narrows the match, (2) a **confidence** score in [0,1], and (3) the
**evidence** list (message subjects/snippets you relied on). These populate the ReasoningStep.
