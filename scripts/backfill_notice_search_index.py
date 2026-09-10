"""Backfill the notice search index from the notices already in `recon-notices`.

The IDP hook indexes every notice it writes, so this is only for rows that predate that -- and for any
row whose postings were lost. It is safe to re-run: `reindex` is delete-then-write keyed on
(field, value), so a second pass converges on the same postings rather than duplicating them.

⚠️ Reads the extraction from `idp_sections[].fields`, which is the only place extracted content lives.
A row with no sections contributes nothing and is REPORTED rather than skipped silently -- a notice with
no postings is invisible to every field search while looking perfectly healthy in the table and on the
Documents tab, so "how many rows could not be indexed" is the number an operator needs.

Tracking-only rows (`record_kind == "document"`) are excluded. They are pipeline plumbing for a document
recon could not map to a notice; `search_notices` already filters them out of results, so indexing them
would put ids in the index that the reader is obliged to discard.

    python3 scripts/backfill_notice_search_index.py --table recon-dev-notices \\
        --index-table recon-dev-notice-search --profile <profile> --region us-east-1 --dry-run
"""

import argparse
import sys
from pathlib import Path
from typing import Any

import boto3

# This script imports the SAME encoder the IDP hook uses, so the repo root has to be importable when it
# is run as `python3 scripts/...` (which puts `scripts/` on the path, not the root). Sharing rather than
# duplicating is the point: a backfilled posting must land under a byte-identical key to a freshly
# ingested one, and two copies of the encoding would drift into producing different keys for the same
# value — which is invisible until a search silently misses the backfilled rows.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.recon_core.notice_index import (  # noqa: E402  (path set up immediately above)
    NoticeSearchIndex,
    flatten_sections,
    postings_for,
)

# Only what the backfill reads. A full-row scan would pull `idp_pages` and every confidence record for
# no reason -- at 5,000 notices/month that is the difference between a scan measured in megabytes and
# one measured in tens of them.
PROJECTION = "notice_id, record_kind, idp_sections"


def iter_notices(*, table: Any) -> Any:
    """Yield every row in the notices table, following pagination.

    :param table: a boto3 DynamoDB ``Table`` resource for the notices table.
    :yields: each projected row.
    """
    kwargs: dict[str, Any] = {"ProjectionExpression": PROJECTION}
    while True:
        resp = table.scan(**kwargs)
        yield from resp.get("Items", [])
        token = resp.get("LastEvaluatedKey")
        if not token:
            return
        kwargs["ExclusiveStartKey"] = token


def backfill(*, table: Any, index: NoticeSearchIndex, dry_run: bool) -> dict[str, int]:
    """Index every notice row, reporting what could not be indexed.

    :param table: a boto3 Table resource for the notices table.
    :param index: the search index to write.
    :param dry_run: when true, report what would be written and write nothing.
    :returns: counts keyed ``notices``, ``postings``, ``tracking_rows``, ``no_fields``.
    """
    counts = {"notices": 0, "postings": 0, "tracking_rows": 0, "no_fields": 0}
    unindexable: list[str] = []

    for row in iter_notices(table=table):
        notice_id = row.get("notice_id")
        if not notice_id:
            continue
        # Compared against the literal, never by truthiness: a row written before `record_kind` existed
        # has no such attribute and IS a real notice, so a truthiness test would exclude exactly the
        # rows this backfill exists for.
        if row.get("record_kind") == "document":
            counts["tracking_rows"] += 1
            continue

        fields = flatten_sections(row.get("idp_sections"))
        if not fields:
            counts["no_fields"] += 1
            unindexable.append(notice_id)
            continue

        counts["notices"] += 1
        if dry_run:
            counts["postings"] += sum(1 for _ in postings_for(notice_id=notice_id, fields=fields))
        else:
            counts["postings"] += index.reindex(notice_id=notice_id, fields=fields)

    print(
        f"{'would index' if dry_run else 'indexed'} {counts['notices']} notice(s) "
        f"-> {counts['postings']} posting(s)"
    )
    print(f"skipped {counts['tracking_rows']} tracking-only row(s) (record_kind=document)")
    if unindexable:
        # Named, not counted. These rows are findable by notice_id and on the Documents tab and by
        # nothing else, and the operator cannot chase what the script will not name.
        print(
            f"\n⚠️  {len(unindexable)} notice(s) carry no extracted fields and are therefore not "
            "searchable by field:"
        )
        for notice_id in sorted(unindexable):
            print(f"      {notice_id}")
    return counts


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and run the backfill.

    :param argv: argument vector, defaulting to ``sys.argv[1:]``.
    :returns: process exit status.
    """
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--table", required=True, help="the notices table to read")
    parser.add_argument("--index-table", required=True, help="the search index table to write")
    parser.add_argument("--profile", default=None, help="AWS profile to use")
    parser.add_argument("--region", default=None, help="AWS region both tables are in")
    parser.add_argument(
        "--dry-run", action="store_true", help="report what would be written and write nothing"
    )
    args = parser.parse_args(argv)

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    resource = session.resource("dynamodb")
    backfill(
        table=resource.Table(args.table),
        index=NoticeSearchIndex(table_name=args.index_table, ddb=resource.Table(args.index_table)),
        dry_run=args.dry_run,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
