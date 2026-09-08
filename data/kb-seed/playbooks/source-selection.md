# Policy — Using guidance vs. live sources

Applies to **every** break class. Which source answers which kind of question.

- **This KB (`Retrieve` via the AgentCore Gateway connector)** holds two different kinds of
  content, distinguished by the `doc_type` metadata attribute:
  - `playbook` — methodology. _How_ to reconcile a break of a given class. Filter on
    `doc_type = "playbook"`.
  - `email` / `email_attachment` — **archived counterparty correspondence** and the documents
    that arrived with it (remittance advices, agent notices, allocation and revaluation
    schedules). This is precedent: how a comparable item was explained and resolved before.
    Filter on `doc_type = "email"`, and narrow with `sender`, `subject`, `received_date` or
    `break_class`.
- **Microsoft Graph tool:** the **live** mailbox and SharePoint. Use it for anything the
  archive does not contain — a message received since the last ingestion, a settlement
  calendar, a counterparty contact.
- **`search_notices`:** the extracted fields of counterparty notices, including the one attached to
  the item under investigation. This is the actual side of the reconciliation and the normal way to
  reach a notice. A field this notice's class never carried comes back in `fields_unavailable`, which
  is not the same as not matching.
- **IDP MCP (document-extraction):** the raw extraction for one document, when `search_notices` is not
  enough — a specific section, a page image, an extraction detail that was not stored on the notice.
  It is the narrower channel, not the default one.
- **`search_ledger`:** the book of record — what was EXPECTED. Never a notice source.

## Two routes bring documents in, and they carry different evidence

A document reaching this platform takes one of two routes, and which one it took changes what you can
say about it:

- **Extraction** produces a **notice**: structured fields, per-field confidence, and a count of fields
  the pipeline flagged as low-confidence. Reached with `search_notices`.
- **The knowledge base** holds a document a person read and filed. It has no per-field confidence,
  because nothing extracted fields from it — a human judged it worth keeping. Reached with the KB
  retrieval tool, filtered on `doc_type`.

Neither route is the trustworthy one. An extracted notice carries machine confidence you can inspect; a
filed document carries a person's judgement you cannot. Say which route your evidence came from, because
an analyst reading the case cannot tell from the content alone.

## The archive is not the live mailbox

Search the KB archive **first** — it is cheaper, and it is the only source that carries
precedent for _older_ items. Fall back to the Graph tool when the archive returns nothing
relevant, or when the question is about something recent.

Two things the archive is not:

- **It is not current.** An archived email is a point-in-time record. Check `received_date`
  before relying on it, and prefer the most recent message on a subject. An instruction in a
  message from months ago may since have been superseded — cite it as precedent, never as
  standing authority.
- **It is not the document for this break.** An archived remittance advice explains the
  _pattern_; the notice for the item under investigation comes from IDP. Do not carry amounts,
  identifiers or dates from an archived attachment into a proposed resolution for a different
  item.

If two sources disagree about the same item, prefer the one that read the document for THIS item over
one that read a document about a comparable one. An extracted notice for the item under investigation
beats an archived message about a similar item; an archived message about this exact item beats an
extraction that could not resolve the field in question. Where the disagreement is material and you
cannot resolve it on that basis, say both figures and escalate — a silently chosen winner is the worst
outcome, because the case then reads as settled.
