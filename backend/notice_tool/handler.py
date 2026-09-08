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

# Fields a caller may filter on that are class-dependent, i.e. legitimately absent from some
# notices. Filtering on one of these NEVER excludes a row; it annotates it instead.
CLASS_DEPENDENT_FIELDS = ("fund", "facility", "reference", "amount", "currency", "activity_type")

# Stored attributes withheld from the tool's rows. `idp_pages` is page-image S3 locations, read by the
# case screen directly from the table — the model cannot act on them, and a notice now carries ~30
# attributes, so returning them spends the agent's context on nothing. This tool returns the MATCHABLE
# projection of a notice, not the stored row.
WITHHELD_FIELDS = ("idp_pages",)

# The subset of CLASS_DEPENDENT_FIELDS compared for string equality. `amount` is deliberately NOT
# here: it is matched by the tolerance band in _matches. Equality-matching it would reject every
# row whose amount differs from the centre by any amount at all, making amount_tolerance a no-op.
EXACT_MATCH_FIELDS = ("fund", "facility", "reference", "currency", "activity_type")


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


def _matches(row: dict[str, object], *, plan: QueryPlan, hints: dict[str, str]) -> bool:
    """Decide whether a fetched row satisfies the non-key filters.

    A hint naming a CLASS_DEPENDENT_FIELD that this row does not carry is NOT a mismatch — the row
    is kept and the field is reported in ``fields_unavailable`` by the caller.

    :param row: the raw DynamoDB item.
    :param plan: the query plan, for the amount band and the date bounds.
    :param hints: the caller's equality filter hints, field name -> value.
    :returns: True when the row should be returned.
    """
    for name, value in hints.items():
        if name not in row:
            if name in CLASS_DEPENDENT_FIELDS:
                continue  # absent for this class: annotate, do not exclude
            return False
        if str(row[name]).strip().lower() != value.strip().lower():
            return False
    if plan.amount_low is not None and "amount" in row:
        if not (plan.amount_low <= Decimal(str(row["amount"])) <= plan.amount_high):
            return False
    if plan.date_from and str(row.get("notice_date", "")) < plan.date_from:
        return False
    if plan.date_to and str(row.get("notice_date", "")) > plan.date_to:
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
    # A facility/fund hint that never became a key condition still needs annotating, so carry the
    # caller's raw hints too — filtered_fields drops the one that became the key.
    for name in EXACT_MATCH_FIELDS:
        if event.get(name) and name not in hints and name != plan.key_field:
            hints[name] = str(event[name])

    # Every class-dependent field the caller leaned on, whether by equality or by band. This is
    # what gets annotated per row; `hints` alone would omit the band-matched amount.
    referenced = {name for name in hints if name in CLASS_DEPENDENT_FIELDS}
    if plan.amount_low is not None:
        referenced.add("amount")

    rows: list[dict[str, object]] = []
    for raw in resp.get("Items", []):
        if not _matches(raw, plan=plan, hints=hints):
            continue
        row = {k: v for k, v in raw.items() if k not in WITHHELD_FIELDS}
        row["fields_unavailable"] = sorted(n for n in referenced if n not in raw)
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
