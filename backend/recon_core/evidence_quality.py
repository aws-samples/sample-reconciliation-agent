"""Whether the evidence a proposal rests on is good enough to write from.

This decides ONE thing: can the platform's write guard evaluate the evidence, and did it come out clean.
It is not a judgement about whether the match is right — that is what the confidence band and the
evidence-completeness score are for. A proposal can be ``CLEAN`` here and still be wrong.

**Why this exists at all, rather than at the gateway.** The obvious place to answer the question is the
gateway interceptor, by looking up the notice a proposal cited and reading its extraction alert count.
That only covers documents that arrive through extraction, which is one of two routes; the other
produces no alert count, so such a guard is silently VOIDED on it. A proposal grounded on retrieved
guidance cites no notice, an absent notice id reads as "nothing to be doubtful about", and the write
passes ungated. Deciding it here, over whatever sources the proposal actually cited, is what closes that.

**Three verdicts, and the distinction between the last two matters.**

* ``CLEAN`` — the guard evaluated the evidence and it is usable.
* ``DOUBTFUL`` — the guard evaluated it and it is not trustworthy. The extraction flagged fields.
* ``UNVERIFIABLE`` — the guard could not evaluate it. Not the same finding: "we checked and it is bad"
  and "we could not check" call for different corrections, and collapsing them into one refusal would
  tell an operator to fix the wrong thing.

**Guidance versus correspondence.** The knowledge base holds two kinds of document behind one retrieval
mechanism, and only one of them can ever be cited to resolve a case:

* a ``playbook`` is METHOD. "Group the ledger records whose sum matches the wire" asserts nothing about
  any particular item, so there is no fact in it to cite. Never evidence, under any configuration.
* an ``email`` / ``email_attachment`` is a statement by a counterparty. Weaker than an extracted notice
  — no per-field confidence, and it may concern a comparable item rather than this one — but the same
  KIND of thing, and usable when an operator has enabled that route in Config.

⚠️ **A playbook consulted is not a playbook cited.** Do not be tempted to refuse any proposal that
touched guidance without matching a notice: *every* investigation consults method, so that rule refuses
nearly every legitimate ledger-only resolution. Retrieving a playbook is normal, encouraged behaviour
and says nothing about what the conclusion rests on.

So the rule reacts only to documents that purport to be **evidence about an item**:

* a ``playbook``, or a document whose kind cannot be established, is **ignored** — it can never make a
  verdict ``CLEAN``, and it never makes one worse either. It is simply not on this axis.
* ``email`` / ``email_attachment`` **is** actual-side evidence, and a proposal resting on it without a
  notice is exactly the case the config toggle governs.

A proposal with no document evidence at all still reaches ``CLEAN``: both backends require a single clean
ledger reference before they build an action, so such a proposal rests on the book of record, which is a
legitimate way to resolve an item.
"""

from decimal import Decimal

# The verdicts. Strings rather than an enum because the value crosses a DynamoDB round trip and a
# gateway interceptor written against the same three literals; an enum would be unwrapped at both ends.
CLEAN = "CLEAN"
DOUBTFUL = "DOUBTFUL"
UNVERIFIABLE = "UNVERIFIABLE"

# The attribute extraction writes on every notice: how many fields it scored below their own confidence
# threshold. Its ABSENCE is meaningful — see _judge_one_notice.
ALERT_COUNT = "confidence_alert_count"

# Knowledge-base document kinds. `playbook` is method and can never be evidence; the other two are
# counterparty correspondence and can be, subject to config. These are the values the corpus's metadata
# sidecars carry (data/kb-seed/**/*.metadata.json).
DOC_TYPE_PLAYBOOK = "playbook"
CITABLE_DOC_TYPES = frozenset({"email", "email_attachment"})


def _judge_one_notice(notice: dict) -> tuple[str, str]:
    """Judge a single cited notice on its extraction alert count.

    Four outcomes, three of which the previous case-row implementation would have read as clean:

    * a zero count — the extraction flagged nothing;
    * a positive count — it flagged fields, so a write from it needs a human;
    * a NULL count — the extraction output could not be read at all. An unread extraction is not a
      clean one, and this is the third state the mapper propagates deliberately;
    * no such attribute — every extracted notice carries one, so a row without it is not a row this
      guard reasons about. Treating it as zero would deactivate the guard for exactly the rows that
      never went through the pipeline it checks.

    :param notice: the notice row as ``search_notices`` returned it.
    :returns: ``(verdict, reason)``.
    """
    notice_id = str(notice.get("notice_id") or "<unidentified>")
    if ALERT_COUNT not in notice:
        return UNVERIFIABLE, (
            f"notice {notice_id} records no {ALERT_COUNT}; every extracted notice carries one, so "
            "this row is not one the extraction guard can vouch for"
        )
    raw = notice[ALERT_COUNT]
    if raw is None:
        return UNVERIFIABLE, (
            f"notice {notice_id} has an unresolved {ALERT_COUNT} — the extraction output could not "
            "be read, and an unread extraction is not a clean one"
        )
    # DynamoDB hands numbers back as Decimal. `bool` is excluded explicitly because it is a subclass of
    # int, and True would otherwise compare as a count of one.
    if isinstance(raw, bool) or not isinstance(raw, (int, float, Decimal)):
        raise TypeError(f"{ALERT_COUNT} on notice {notice_id} is {type(raw).__name__}: {raw!r}")
    alerts = int(raw)
    # `<= 0`, not `if not alerts`: zero is the CLEAN case and is falsy, so a truthiness test here
    # inverts the guard's most common outcome.
    if alerts <= 0:
        return CLEAN, f"notice {notice_id} extraction flagged no low-confidence fields"
    return DOUBTFUL, (
        f"{alerts} extracted field(s) on notice {notice_id} were flagged low-confidence — a ledger "
        "write from a doubtful extraction requires a human"
    )


def _doc_types(kb_documents: list[dict]) -> set[str]:
    """Collect the ``doc_type`` of every cited knowledge-base document.

    An unreadable or absent ``doc_type`` maps to the empty string rather than being skipped: a document
    whose kind cannot be established must not be silently dropped from the judgement, because dropping
    it is how a citation becomes invisible.

    :param kb_documents: retrieval results, each carrying a ``metadata`` mapping.
    :returns: the set of doc_type values seen, with ``""`` standing for "could not tell".
    """
    seen: set[str] = set()
    for document in kb_documents:
        metadata = document.get("metadata") or {}
        seen.add(str(metadata.get("doc_type") or ""))
    return seen


def decide_evidence_quality(
    *,
    notices: list[dict],
    kb_documents: list[dict],
    kb_evidence_enabled: bool,
) -> tuple[str, str]:
    """Judge the evidence a proposal cited, and say why in terms an operator can act on.

    The reason is not decoration. It is quoted verbatim in the gateway's denial and shown on the case, so
    it has to name the specific source and the specific problem — an operator reading "unverifiable" has
    no next action, and one reading "the knowledge-base route is not enabled as an evidence source in
    Config" has exactly one.

    :param notices: notice rows the investigation matched, as ``search_notices`` returned them.
    :param kb_documents: knowledge-base retrieval results the investigation cited. Pass them ALL,
        including playbooks — see the module docstring for why filtering here breaks the judgement.
    :param kb_evidence_enabled: whether an operator has enabled the knowledge-base route as an evidence
        source (a workflow type with ``route = "knowledge-base"`` and ``active = true``). Resolved by the
        caller so this function stays pure and testable.
    :returns: ``(verdict, reason)`` where verdict is CLEAN, DOUBTFUL or UNVERIFIABLE.
    :raises TypeError: when a notice's alert count is present but not a number — a shape this platform
        wrote and therefore must never see.
    """
    # More than one distinct notice is UNVERIFIABLE, and this is a hole the previous implementation had:
    # `derive_notice_id` returns None when a search matched several, an absent id read as "nothing to
    # doubt", and the write passed. `record-match-review` declares `cardinality: ranked_set`, so a
    # multi-candidate result is routine rather than exotic.
    distinct = {str(n.get("notice_id")) for n in notices if n.get("notice_id")}
    if len(distinct) > 1:
        return UNVERIFIABLE, (
            f"the investigation matched {len(distinct)} distinct notices "
            f"({', '.join(sorted(distinct))}); which one the write rests on is unresolved, so the "
            "extraction behind it cannot be judged"
        )

    if distinct:
        return _judge_one_notice(notices[0])

    # No notice. What matters now is whether anything ACTUAL-SIDE was retrieved — a counterparty's own
    # correspondence — as opposed to method, which every investigation consults.
    citable = _doc_types(kb_documents) & CITABLE_DOC_TYPES
    if not citable:
        # Nothing that purports to be evidence about this item. Guidance may well have been consulted
        # and that is fine: it informs HOW the investigation ran, not what it concluded. The proposal
        # rests on the ledger, which both backends already require a single clean reference for.
        return CLEAN, "no document evidence was cited; the proposal rests on the ledger alone"

    if not kb_evidence_enabled:
        return UNVERIFIABLE, (
            "the only evidence cited is archived correspondence, and the knowledge-base route is not "
            "enabled as an evidence source in Config; enable it there, or route the document through "
            "extraction so it becomes a notice"
        )

    return CLEAN, (
        f"archived counterparty correspondence ({', '.join(sorted(citable))}) is cited and the "
        "knowledge-base route is enabled as an evidence source"
    )


def kb_evidence_enabled(*, table_name: str, ddb=None) -> bool:
    """Report whether an operator has enabled the knowledge-base route as an evidence source.

    "Enabled" means at least one workflow type in the Config screen has ``route = "knowledge-base"`` and
    ``active = true``. That row is what an operator uses to declare that archived correspondence counts —
    the same row whose ``kb_doc_type`` stamps uploaded documents.

    ⚠️ **This is the only impure function in the module, and it is separate from the decision on purpose.**
    ``decide_evidence_quality`` takes the answer as a boolean so it stays testable without AWS, and so the
    read happens exactly once per proposal rather than once per candidate. Call it from intake, which is
    off the write path; do NOT call it from the gateway interceptor, which sits on every tool call.

    A read failure RAISES rather than returning False. False is a policy statement — "the operator has not
    enabled this" — and a table we could not reach is not a policy statement. Defaulting to False would
    silently refuse every correspondence-grounded write during a transient DynamoDB problem, and the
    refusal would name Config, sending an operator to a screen where the setting is already correct.

    :param table_name: the workflow-types table.
    :param ddb: injectable DynamoDB resource (tests); the real resource by default.
    :returns: True when at least one active knowledge-base workflow type exists.
    :raises RuntimeError: when the table cannot be read.
    """
    import boto3

    resource = ddb or boto3.resource("dynamodb")
    try:
        # Scanned, not queried: `active` cannot be indexed (DynamoDB will not key on a BOOLEAN — see the
        # workflow-types module) and the table holds a handful of rows an operator maintains by hand.
        rows = resource.Table(table_name).scan().get("Items", [])
    except Exception as exc:
        raise RuntimeError(f"could not read workflow types from {table_name}: {exc}") from exc
    return any(
        str(row.get("route") or "") == "knowledge-base" and bool(row.get("active")) for row in rows
    )
