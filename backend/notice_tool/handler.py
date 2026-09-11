"""The search_notices Gateway tool: query the ACTUAL side of the reconciliation.

Notices are documents whose available fields vary by class, so this tool never treats a missing
field as a non-match — it reports it in ``fields_unavailable``. An empty ``rows`` list means
"searched, found nothing"; a read failure RAISES. The two are never conflated: a broken read that
returned an empty list would look to the agent like a notice that does not exist.
"""

import os
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

import boto3
from boto3.dynamodb.conditions import Key

# DynamoDB page/result cap. Matches backend/gl_tool/handler.py so the two tools agree.
MAX_LIMIT = 100

# This tool's OWN input names that are not field filters. Everything else the caller sends is treated
# as an equality filter on a field of that name, whatever it is called.
#
# ⚠️ A DENYLIST, and that direction is the point. An allowlist of extracted field names would make a
# field the pipeline starts extracting unfilterable until somebody edits this file, and one it renames
# silently unfilterable. The rule this module follows: recon may hardcode names IT owns; it may never
# hardcode names the extraction configuration owns.
CONTROL_PARAMS = frozenset(
    {"amount", "amount_tolerance", "date_from", "date_to", "limit", "notice_date"}
)

# Recon's own structural attributes on a notice row. Everything else a row carries is extracted
# content, whose absence is ALWAYS class-dependent and must therefore be annotated rather than treated
# as a non-match. These are never absent, so they never reach that branch -- they are listed so the
# distinction is explicit rather than implied by a list of IDP's field names.
STRUCTURAL_FIELDS = frozenset(
    {"notice_id", "notice_class", "record_kind", "source_system", "parse_method"}
)

# Stored attributes withheld from the tool's rows. `idp_pages` is page-image S3 locations, read by
# the case screen directly from the table — the model cannot act on them, and a notice now carries
# ~30 attributes, so returning them spends the agent's context on nothing. This tool returns the
# MATCHABLE projection of a notice, not the stored row. `record_kind`, `idp_record` and
# `idp_started_at` are the discriminator and the GSI key attributes derived from it (see
# backend/recon_core/notices._idp_gsi_attrs) — they exist to let the Documents tab and its own GSI
# tell a tracking row from a real notice, which is pipeline plumbing the model has no use for once
# `_matches` has already excluded the tracking rows. `idp_tracking` is the IDP pipeline's own
# progress/timing snapshot for the document, embedded for the Documents tab's benefit; same
# reasoning as `idp_pages` above — the model cannot act on pipeline tracking state, and it is not
# part of the notice's matchable, extracted content.
WITHHELD_FIELDS = ("idp_pages", "record_kind", "idp_record", "idp_started_at", "idp_tracking")


def _extracted_fields(row: dict) -> dict:
    """Flatten a row's embedded extraction into one field map.

    This is what makes the tool dynamic: `idp_sections[].fields` is IDP's ``inference_result``
    verbatim, so every extracted field is filterable under the name the extractor gave it, with no
    entry in any list here. A field the pipeline starts emitting tomorrow is searchable tomorrow.

    First section wins on a duplicate key, matching how ``idp_event_to_notice`` derives a notice's
    scalars from ``sections[0]`` — so a multi-section document answers a filter with the same value it
    put in its top-level attributes, rather than one from a later section that disagrees.

    :param row: the raw DynamoDB item.
    :returns: field name -> value, empty when the row embeds no sections.
    """
    out: dict = {}
    sections = row.get("idp_sections")
    if not isinstance(sections, list):
        return out
    for section in sections:
        if not isinstance(section, dict):
            continue
        fields = section.get("fields")
        if isinstance(fields, dict):
            for name, value in fields.items():
                out.setdefault(name, value)
    return out


def _resolve(name: str, *, row: dict, extracted: dict):
    """Read one field for matching, taking the index-visible attribute over the embedded copy.

    The three index key attributes exist both as attributes and inside the extraction. The attribute
    wins because it is the value the GSI was built from and the one the mapper normalised, so a filter
    can never match a row the index would not have returned. Every other field resolves from the
    extraction, which is the only place it lives.

    :param name: the field name the caller filtered on.
    :param row: the raw DynamoDB item.
    :param extracted: the flattened extraction from :func:`_extracted_fields`.
    :returns: the value, or None when the row carries the field nowhere.
    """
    if name in row:
        return row[name]
    return extracted.get(name)


# What a section is projected down to for the model. `classification` says which document the fields came
# out of, and `fields` is the extracted content -- since extracted content is not a top-level attribute,
# this IS the notice's payload rather than a duplicate of it, so it cannot be withheld wholesale the way
# `idp_pages` is.
#
# Everything else is dropped. `confidences` is the bulk of it -- 72% of the sections and 39% of the whole
# row on the live corpus -- and the model cannot act on a per-field score: the confidence the agent is
# gated on is the notice-level `extraction_confidence`/`confidence_alert_count` pair, which stays, and it
# is the same number the gateway interceptor refuses ledger writes on. `section_id`, `page_ids`,
# `mean_confidence` and `alert_count` are pipeline bookkeeping. The Documents tab still renders all of it,
# because it reads the table directly rather than through this tool.
SECTION_PROJECTION = ("classification", "fields")


def _trim_sections(sections: object) -> list[dict]:
    """Project a row's embedded sections down to what the model can use.

    :param sections: the row's raw ``idp_sections`` value.
    :returns: one dict per section carrying only :data:`SECTION_PROJECTION`, empty when there are none.
    """
    if not isinstance(sections, list):
        return []
    out: list[dict] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        out.append({k: section[k] for k in SECTION_PROJECTION if k in section})
    return out


def _as_decimal(value: object) -> Decimal | None:
    """Parse a stored field value as a number, or None when it is not one.

    None rather than a raise, and the asymmetry with :func:`_decimal` is deliberate. A non-numeric value
    in the CALLER's input is a bad request and fails loudly, because a band silently widened to
    everything reads as a successful broad match. A non-numeric value in ONE STORED ROW is bad data in
    the corpus, and raising on it would let a single unparseable amount break every amount search
    against the whole table. The row is reported as un-comparable instead, which is the same treatment a
    field the class never extracted gets.

    :param value: the stored value, typically the string the extractor emitted.
    :returns: the Decimal, or None when it will not parse.
    """
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


@dataclass(frozen=True)
class QueryPlan:
    """How a search_notices call will be executed against recon-notices."""

    index_name: str | None
    key_field: str | None
    key_value: str
    is_scan: bool
    has_date_range: bool
    date_from: str
    date_to: str
    amount_low: Decimal | None
    amount_high: Decimal | None
    limit: int
    # Hints that could not become key conditions and are applied as filter expressions instead.
    filtered_fields: dict[str, str] = field(default_factory=dict)


def _decimal(value: str, *, label: str) -> Decimal:
    """Parse a caller-supplied decimal string, failing loudly.

    :param value: the raw string from the tool invocation.
    :param label: the parameter name, for the error message.
    :returns: the parsed Decimal.
    :raises ValueError: when the string is not a decimal — silently ignoring it would widen the
        search to every notice, which reads as a successful broad match.
    """
    try:
        return Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{label} is not a number: {value!r}") from exc


def plan_query(
    *,
    counterparty: str = "",
    fund: str = "",
    reference: str = "",
    amount: str = "",
    amount_tolerance: str = "0",
    date_from: str = "",
    date_to: str = "",
    notice_class: str = "",
    activity_type: str = "",
    limit: int = 25,
) -> QueryPlan:
    """Choose the access path and filters for a search_notices call.

    Priority: ``reference`` (most selective) -> ``counterparty`` -> a marked full Scan. Any hint
    that does not become a key condition is applied as a filter instead, never dropped.

    :param counterparty: exact counterparty name as extracted from the notice.
    :param fund: fund label; always a filter, because alias resolution is not an equality match.
    :param reference: exact wire/transaction reference.
    :param amount: amount to match, as a decimal string.
    :param amount_tolerance: symmetric tolerance around ``amount``, as a decimal string.
    :param date_from: inclusive lower bound on ``notice_date`` (ISO-8601).
    :param date_to: inclusive upper bound on ``notice_date`` (ISO-8601).
    :param notice_class: exact notice class; always a filter.
    :param activity_type: the business activity (Interest / Rateset / Rollover / Commitment Fee /
        Paydown); always a filter, never a key condition, and class-dependent — an aggregated advice
        legitimately carries none, so filtering on it annotates such a row rather than excluding it.
    :param limit: caller's requested row cap, clamped to [1, MAX_LIMIT].
    :returns: the plan describing index, key condition, filters and amount band.
    :raises ValueError: when a tolerance is given without an amount, or a numeric field will not
        parse. Both would otherwise silently broaden the search.
    """
    if amount_tolerance not in ("", "0") and not amount:
        raise ValueError("amount_tolerance given without amount")
    amount_low: Decimal | None = None
    amount_high: Decimal | None = None
    if amount:
        centre = _decimal(amount, label="amount")
        span = _decimal(amount_tolerance or "0", label="amount_tolerance")
        if span < 0:
            raise ValueError(f"amount_tolerance must not be negative: {amount_tolerance!r}")
        amount_low, amount_high = centre - span, centre + span

    filtered: dict[str, str] = {}
    for name, value in (
        ("fund", fund),
        ("notice_class", notice_class),
        ("activity_type", activity_type),
    ):
        if value:
            filtered[name] = value

    if reference:
        index_name, key_field, key_value = "reference-index", "reference", reference
        if counterparty:
            filtered["counterparty"] = counterparty
        has_date_range = False
    elif counterparty:
        index_name, key_field, key_value = "counterparty-index", "counterparty", counterparty
        has_date_range = bool(date_from or date_to)
    else:
        index_name, key_field, key_value = None, None, ""
        has_date_range = False

    # Dates that cannot be a range key condition must still constrain the result set.
    if (date_from or date_to) and not has_date_range:
        filtered["notice_date"] = f"{date_from or '*'}..{date_to or '*'}"

    return QueryPlan(
        index_name=index_name,
        key_field=key_field,
        key_value=key_value,
        is_scan=index_name is None,
        has_date_range=has_date_range,
        date_from=date_from,
        date_to=date_to,
        amount_low=amount_low,
        amount_high=amount_high,
        # `limit or 25` would be wrong: 0 is falsy, so an explicit 0 would silently become 25
        # instead of clamping to 1. Only an ABSENT limit gets the default.
        limit=max(1, min(int(25 if limit is None else limit), MAX_LIMIT)),
        filtered_fields=filtered,
    )


def _unavailable(row: dict, *, referenced: set[str], plan: QueryPlan) -> list[str]:
    """The fields the caller leaned on that this row could not answer.

    Unavailable means the row carries the field NOWHERE — not as an attribute and not in its embedded
    extraction — or carries a value the comparison could not use. Both are "we could not check this for
    you", which is what the agent must be told; a row returned with an empty list is a row claiming every
    requested field was verified against it.

    Resolving through the extraction is what keeps this honest now that extracted fields are not
    attributes: testing membership of the raw item alone would report a field the row plainly carries as
    unavailable, and the agent reads that as "this class does not extract it" and stops looking.

    :param row: the raw DynamoDB item.
    :param referenced: every field name the caller filtered or bounded on.
    :param plan: the query plan, for whether the amount band was requested.
    :returns: the sorted field names, empty when the row answered everything asked of it.
    """
    extracted = _extracted_fields(row)
    out = {n for n in referenced if _resolve(n, row=row, extracted=extracted) is None}
    # Present but not a number: the band could not be applied, so say so rather than imply it passed.
    if plan.amount_low is not None and "amount" not in out:
        if _as_decimal(_resolve("amount", row=row, extracted=extracted)) is None:
            out.add("amount")
    return sorted(out)


def _matches(row: dict[str, object], *, plan: QueryPlan, hints: dict[str, str]) -> bool:
    """Decide whether a fetched row satisfies the non-key filters.

    A hint naming a field this row does not carry — top-level OR in its embedded extraction — is NOT a
    mismatch. The row is kept and the field is reported in ``fields_unavailable`` by the caller. That is
    the rule for EVERY field, not a listed subset: every extracted field is class-dependent by nature and
    recon cannot enumerate the ones the pipeline emits. Only :data:`STRUCTURAL_FIELDS` excludes on
    absence, and none of those is ever absent.

    :param row: the raw DynamoDB item.
    :param plan: the query plan, for the amount band and the date bounds.
    :param hints: the caller's equality filter hints, field name -> value.
    :returns: True when the row should be returned.
    """
    # A tracking-only row (record_kind == "document") is pipeline plumbing, not evidence about a
    # reconciliation item — it has no notice_date, no counterparty, no extracted fields, and it
    # carries a notice_failure_reason instead. It must never reach the agent as a "notice" result.
    # The `"notice"` default is NOT a defensive fallback: every row written before record_kind
    # existed has no such attribute at all, and every one of those rows IS a real notice. Tightening
    # this to `row.get("record_kind") == "notice"` would silently hide all of them — most of the
    # table — exactly the fail-quiet behaviour this module exists to avoid elsewhere. This is the
    # single choke point: both the indexed-query path and the scan path below run every candidate
    # row through this function, so the guard belongs here and nowhere else.
    if row.get("record_kind", "notice") != "notice":
        return False
    extracted = _extracted_fields(row)
    for name, value in hints.items():
        stored = _resolve(name, row=row, extracted=extracted)
        if stored is None:
            # Absent here OR in the embedded extraction: annotate, do not exclude. A STRUCTURAL field
            # is the one case where absence is a real mismatch, and none of those is ever absent -- so
            # this stays a mismatch only for a caller inventing a recon-owned name.
            if name in STRUCTURAL_FIELDS:
                return False
            continue
        if str(stored).strip().lower() != value.strip().lower():
            return False
    # The extraction stores what the document printed, as a string, so parsing happens here. A value
    # that will not parse leaves the row un-comparable rather than excluded or fatal -- see
    # `_as_decimal`, and `_unavailable` which reports it to the agent.
    if plan.amount_low is not None:
        amount = _as_decimal(_resolve("amount", row=row, extracted=extracted))
        if amount is not None and not (plan.amount_low <= amount <= plan.amount_high):
            return False
    # Applied ONLY to a row that carries a date. A dateless notice is kept and annotated, exactly as an
    # amount-less one is above. ⚠️ Never fold the absent case into the comparison by defaulting to `""`:
    # that sorts below every ISO date, so a `date_from` bound alone would drop every dateless notice from
    # every bounded search, and nothing anywhere would say so.
    stored_date = _resolve("notice_date", row=row, extracted=extracted)
    if stored_date is not None:
        if plan.date_from and str(stored_date) < plan.date_from:
            return False
        if plan.date_to and str(stored_date) > plan.date_to:
            return False
    return True


def handle(event: dict, _context, *, ddb=None) -> dict[str, object]:
    """Search extracted counterparty notices and return the matching rows.

    :param event: tool input — {counterparty?, fund?, reference?, amount?, amount_tolerance?,
        date_from?, date_to?, notice_class?, limit?}.
    :param _context: Lambda context, unused.
    :param ddb: injectable DynamoDB Table stand-in (tests); the real table by default.
    :returns: ``{"rows": [...], "matched_on": [...], "fields_unavailable": [...],
        "truncated": bool}``. Each row also carries its own ``fields_unavailable``.
    :raises RuntimeError: on any read failure. An empty ``rows`` list means "searched, found
        nothing" and must never stand in for an error.
    """
    plan = plan_query(
        counterparty=event.get("counterparty") or "",
        fund=event.get("fund") or "",
        reference=event.get("reference") or "",
        amount=event.get("amount") or "",
        amount_tolerance=event.get("amount_tolerance") or "0",
        date_from=event.get("date_from") or "",
        date_to=event.get("date_to") or "",
        notice_class=event.get("notice_class") or "",
        activity_type=event.get("activity_type") or "",
        limit=event.get("limit") or 25,
    )
    table = ddb or boto3.resource("dynamodb").Table(os.environ["NOTICES_TABLE"])
    try:
        if plan.is_scan:
            # No selective hint. Capped, and reported as truncated — never a silent partial answer.
            resp = table.scan(Limit=plan.limit + 1)
        else:
            key_condition = Key(plan.key_field).eq(plan.key_value)
            if plan.has_date_range and plan.date_from and plan.date_to:
                key_condition = key_condition & Key("notice_date").between(
                    plan.date_from, plan.date_to
                )
            resp = table.query(
                IndexName=plan.index_name,
                KeyConditionExpression=key_condition,
                Limit=plan.limit + 1,
            )
    except Exception as exc:
        # Fail loudly: the caller must be able to tell a failed read from an empty result.
        raise RuntimeError(f"search_notices read failed: {exc}") from exc

    hints = {k: v for k, v in plan.filtered_fields.items() if k != "notice_date"}
    # Every remaining input the caller sent is an equality filter on a field of that name, whatever it is
    # called -- so a field the pipeline starts extracting is filterable with no change here, because
    # `_matches` resolves the name through the row's embedded extraction. `filtered_fields` wins where it
    # has an entry, since `plan_query` has already normalised those, and the key field is excluded
    # because it became a key condition rather than a filter.
    for name, value in event.items():
        if name in CONTROL_PARAMS or name in hints or name == plan.key_field:
            continue
        if value not in (None, ""):
            hints[name] = str(value)

    # Every field the caller leaned on, whether by equality or by band. This is what gets annotated per
    # row; `hints` alone would omit the band-matched amount.
    referenced = set(hints)
    if plan.amount_low is not None:
        referenced.add("amount")
    # A date bound the caller asked for, whether it became the index range key or a `_matches` bound.
    # `hints` cannot supply this: `notice_date` is stripped from it a few lines above, and on the
    # counterparty-index path the bound never enters `filtered_fields` at all. So without this the
    # dateless notice `_matches` now keeps would come back with an empty `fields_unavailable` -- the
    # agent would see a row that satisfied a date window it was never checked against.
    if plan.date_from or plan.date_to:
        referenced.add("notice_date")

    rows: list[dict[str, object]] = []
    for raw in resp.get("Items", []):
        if not _matches(raw, plan=plan, hints=hints):
            continue
        row = {k: v for k, v in raw.items() if k not in WITHHELD_FIELDS}
        # Trimmed on the OUTPUT row only. Every read that decides anything -- `_matches` above and
        # `_unavailable` below -- resolves against `raw`, so the projection can never change which rows
        # come back or what is reported unavailable about them.
        if "idp_sections" in row:
            row["idp_sections"] = _trim_sections(raw.get("idp_sections"))
        row["fields_unavailable"] = _unavailable(raw, referenced=referenced, plan=plan)
        rows.append(row)

    truncated = len(rows) > plan.limit
    key_fields = {plan.key_field} if plan.key_field else set()
    matched_on = sorted(set(hints) | referenced | key_fields)
    return {
        "rows": rows[: plan.limit],
        "matched_on": matched_on,
        "fields_unavailable": sorted({f for r in rows for f in r["fields_unavailable"]}),
        "truncated": truncated,
    }
