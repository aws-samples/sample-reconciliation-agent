#!/usr/bin/env python3
"""Backfill the `idp-document-index` GSI attributes onto notice rows written before it existed.

WHY THIS EXISTS. The Documents tab is migrating off the IDP pipeline's AppSync API onto recon's
own `*-notices` table. Its list route (a later task) will `Query` the `idp-document-index` GSI
(hash `idp_record`, range `idp_started_at`) over a date window. A DynamoDB item appears in a GSI
ONLY if it carries BOTH key attributes -- and every row written before the hook started promoting
them has neither. Without this backfill the tab would render empty on day one even though every
notice is sitting right there in the table.

WHAT IT TOUCHES. Attribute-only. It copies NO S3 objects and reads NO raw documents: recon
deliberately does not duplicate IDP's source documents into its own storage, so this script only
ever adds the two GSI key attributes (plus the `record_kind` discriminator `search_notices` already
filters on) to rows that already exist. It never creates a row and never touches an extracted field.

WHAT IT SKIPS. A row whose `parse_method` is not exactly `"IDP"` gets `record_kind` only -- never
`idp_record`/`idp_started_at`. Such a row has no pipeline execution behind it, so it does not belong
in an index about what the pipeline processed. (None exist on `recon-dev-notices` today; the branch
must still be correct for whatever shows up later.)

HOW THE TIMESTAMP IS RESOLVED. For an IDP-parsed row, `idp_started_at` prefers
`idp_tracking.initial_event_time` -- the pipeline's own recorded ingestion-start time, passed
through verbatim. Every row measured on `recon-dev-notices` at design time has no `idp_tracking`
at all (it predates that snapshot), so this script falls back to the row's own `notice_date`,
normalised to a full ISO-8601 UTC timestamp at midnight and flagged with
`idp_started_at_approximate = true` so a reader can tell a real pipeline timestamp from a
stand-in. See `_approximate_from_notice_date` for why the normalisation matters.

Usage:
    # Dry run (the default): report what would change, write nothing.
    python3 scripts/backfill_idp_document_index.py --table recon-dev-notices --region us-east-1

    # Actually write the attributes.
    python3 scripts/backfill_idp_document_index.py --table recon-dev-notices --region us-east-1 \\
        --apply

Re-running is safe: a row that already carries every attribute this script would set is left alone
(see `plan_update`), so a second `--apply` run reports every row skipped and writes nothing.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, time, timezone
from typing import Any

import boto3

# The literal `record_kind` value that marks an extracted-notice row (as opposed to a tracking-only
# "document" row -- see backend/recon_core/notices.py's module docstring). Absence means "notice"
# everywhere in this codebase already; this script's job is only to make that convention EXPLICIT on
# rows written before the field existed, never to invent a different default.
NOTICE_RECORD_KIND = "notice"

# The GSI's constant hash-key value for every row it carries -- see
# infra/modules/notice-store/main.tf's `idp-document-index` definition.
IDP_RECORD_VALUE = "document"

# The one `parse_method` this script's GSI backfill applies to.
IDP_PARSE_METHOD = "IDP"


def _approximate_from_notice_date(*, notice_date: str) -> str:
    """Normalise a date-only `notice_date` into a full ISO-8601 UTC timestamp.

    `notice_date` is DATE-ONLY (e.g. ``"2026-08-31"``), but the GSI range key is compared as a
    STRING against full timestamps -- both the ones a later list route sends (e.g.
    ``"2026-08-10T00:00:00.000Z"``) and every hook-written `initial_event_time`
    (`backend/idp_hook/tracking.py`'s ``_epoch_millis_to_iso``, which stamps a fabricated timestamp
    as ``datetime.fromtimestamp(..., tz=timezone.utc).isoformat()``). A bare ``"2026-08-31"`` still
    SORTS plausibly next to those -- ISO date-then-time ordering agrees -- but it is the one value
    in the index shaped differently from every other row, inviting a subtle window-boundary bug the
    day someone assumes every `idp_started_at` carries a ``T``. This uses the exact same
    ``datetime(...).isoformat()`` idiom `tracking.py` uses for its own FABRICATED (not
    IDP-supplied) timestamps, for the same reason: a value this script invents must never be
    mistaken for one IDP itself reported.

    :param notice_date: the notice's `notice_date` field, formatted `YYYY-MM-DD`.
    :returns: a full ISO-8601 UTC timestamp at midnight, e.g. ``"2026-08-31T00:00:00+00:00"``.
    """
    day = date.fromisoformat(notice_date)
    return datetime.combine(day, time.min, tzinfo=timezone.utc).isoformat()


def resolve_idp_started_at(*, row: dict[str, Any]) -> tuple[str, bool]:
    """Resolve the `idp-document-index` range key for one IDP-parsed row.

    :param row: the raw DynamoDB item, already known to have `parse_method == "IDP"`.
    :returns: a pair of (the ISO-8601 UTC timestamp to store, whether it is an approximation
        derived from `notice_date` rather than the pipeline's own recorded start time).
    :raises ValueError: if the row has neither `idp_tracking.initial_event_time` nor a `notice_date`
        to approximate from -- there is nothing this script can index it by, and inventing a value
        with no basis at all would be worse than leaving the row out of the GSI.
    """
    idp_tracking = row.get("idp_tracking") or {}
    initial_event_time = idp_tracking.get("initial_event_time")
    if initial_event_time:
        # The real ingestion-start timestamp. Passed through VERBATIM, never reformatted -- exactly
        # like every other reader of this field (see tracking.py's own "pass through verbatim"
        # rule).
        return str(initial_event_time), False

    notice_date = row.get("notice_date")
    if not notice_date:
        raise ValueError(
            f"notice {row.get('notice_id')!r} has parse_method=IDP but neither "
            "idp_tracking.initial_event_time nor notice_date -- nothing to index it by"
        )
    return _approximate_from_notice_date(notice_date=notice_date), True


def plan_update(*, row: dict[str, Any]) -> dict[str, Any]:
    """Decide which attributes, if any, one row still needs.

    Idempotent by construction: a row that already carries every attribute this script would set
    yields an EMPTY plan, which is what makes a second run a genuine no-op rather than one that
    merely happens to overwrite identical values.

    :param row: the raw DynamoDB item, as returned by `Table.scan`.
    :returns: a dict of attribute-name -> new value to `UpdateItem` with; empty if nothing to do.
    """
    updates: dict[str, Any] = {}

    if "record_kind" not in row:
        updates["record_kind"] = NOTICE_RECORD_KIND

    if row.get("parse_method") == IDP_PARSE_METHOD:
        # Both GSI key attributes are always set TOGETHER (never one without the other), so checking
        # either one's presence is a reliable "already done" marker for this whole branch.
        if "idp_record" not in row or "idp_started_at" not in row:
            started_at, approximate = resolve_idp_started_at(row=row)
            updates["idp_record"] = IDP_RECORD_VALUE
            updates["idp_started_at"] = started_at
            if approximate:
                updates["idp_started_at_approximate"] = True
    # else: parse_method is not exactly "IDP" (including absent). No GSI keys, ever -- such a row
    # has no pipeline execution behind it and does not belong in an index about what the pipeline
    # processed. See the module docstring's "WHAT IT SKIPS" section.

    return updates


def describe_skip_reason(*, row: dict[str, Any]) -> str:
    """Explain, for the per-row report, why a row with an empty plan needed nothing.

    :param row: the raw DynamoDB item.
    :returns: a short human-readable reason.
    """
    if row.get("parse_method") != IDP_PARSE_METHOD:
        return "record_kind already set, and parse_method is not IDP -- no GSI keys apply"
    return "already fully backfilled (record_kind + idp_record + idp_started_at all present)"


def apply_update(*, table: Any, notice_id: str, updates: dict[str, Any]) -> None:
    """UpdateItem exactly the planned attributes onto one row.

    UpdateItem, never PutItem: a put would rewrite the WHOLE row -- including extracted fields the
    reconciliation matcher may already have cited -- to add an index attribute that has nothing to
    do with the notice's content. `ConditionExpression` refuses the write outright (rather than
    upserting a partial item) if the row disappeared between the scan and this call.

    :param table: a boto3 DynamoDB `Table` resource for the notices table.
    :param notice_id: partition key of the row to update.
    :param updates: attribute-name -> new value, as produced by :func:`plan_update`. Must be
        non-empty.
    :returns: None.
    :raises ValueError: if `updates` is empty -- calling this with nothing to write is a caller bug,
        not a no-op to swallow silently.
    :raises botocore.exceptions.ClientError: any DynamoDB error -- including a failed
        `ConditionExpression` -- propagates uncaught. A partial backfill that reports success is
        worse than a crash, because it would produce a Documents tab that silently omits rows.
    """
    if not updates:
        raise ValueError(f"apply_update called with no updates for {notice_id!r}")

    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    set_parts: list[str] = []
    for index, (attribute, value) in enumerate(updates.items()):
        name_placeholder = f"#a{index}"
        value_placeholder = f":v{index}"
        names[name_placeholder] = attribute
        values[value_placeholder] = value
        set_parts.append(f"{name_placeholder} = {value_placeholder}")

    table.update_item(
        Key={"notice_id": notice_id},
        UpdateExpression="SET " + ", ".join(set_parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ConditionExpression="attribute_exists(notice_id)",
    )


def scan_all_rows(*, table: Any) -> list[dict[str, Any]]:
    """Scan the whole table, following `LastEvaluatedKey` to completion.

    A single `scan` call returns at most 1 MB. Not paginating would silently backfill only part of
    the table on any deployment with more than a page's worth of rows, and still report success.

    :param table: a boto3 DynamoDB `Table` resource.
    :returns: every item in the table.
    """
    rows: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {}
    while True:
        page = table.scan(**kwargs)
        rows.extend(page["Items"])
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return rows


def run(*, table: Any, apply: bool) -> dict[str, int]:
    """Backfill every row in `table`, printing a per-row action as it goes.

    :param table: a boto3 DynamoDB `Table` resource for the notices table.
    :param apply: when False (the default), report what would change and write nothing.
    :returns: a summary dict with `examined`, `updated` and `skipped` counts.
    """
    examined = 0
    updated = 0
    skipped = 0

    for row in scan_all_rows(table=table):
        examined += 1
        notice_id = row.get("notice_id", "<unknown>")
        updates = plan_update(row=row)

        if not updates:
            skipped += 1
            print(f"  SKIP      {notice_id}: {describe_skip_reason(row=row)}")
            continue

        verb = "SET" if apply else "WOULD SET"
        print(f"  {verb:<9} {notice_id}: {updates}")
        if apply:
            apply_update(table=table, notice_id=notice_id, updates=updates)
        updated += 1

    return {"examined": examined, "updated": updated, "skipped": skipped}


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and run the backfill.

    :param argv: argument vector, defaulting to `sys.argv[1:]`.
    :returns: process exit status; 0 on success.
    """
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--table",
        default="recon-dev-notices",
        help="notices table name (default: recon-dev-notices)",
    )
    parser.add_argument(
        "--region",
        default=None,
        help="AWS region; default: the standard AWS_REGION/AWS_DEFAULT_REGION credential-chain "
        "resolution boto3 already does when this is omitted",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually write the backfilled attributes; omit to report only (the default)",
    )
    args = parser.parse_args(argv)

    resource = boto3.resource("dynamodb", region_name=args.region)
    table = resource.Table(args.table)

    mode = "APPLYING" if args.apply else "dry run (pass --apply to write)"
    print(f"[backfill] {mode} against {args.table!r}")

    summary = run(table=table, apply=args.apply)

    print(
        f"[backfill] examined={summary['examined']} updated={summary['updated']} "
        f"skipped={summary['skipped']}"
    )
    if not args.apply:
        print("[backfill] nothing was written. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
