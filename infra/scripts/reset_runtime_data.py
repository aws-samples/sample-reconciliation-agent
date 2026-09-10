#!/usr/bin/env python3
"""Delete every accumulated runtime row from a NON-PRODUCTION recon environment's tables.

Why this exists as a committed script rather than a one-off command: the reset has to know which
tables hold *accumulated agent output* (safe to drop) and which hold *declared fixtures* (dropping
them silently breaks the demo and leaves Terraform believing they still exist). Encoding that split
here means the next reset cannot get it wrong from memory.

Tables cleared:
  <prefix>-cases   agent proposals, one row per investigated item
  <prefix>-items   reconciliation items, written by the intake API alone (the IDP hook never
                   writes one — it writes a notice, and the notices table has no stream)
  <prefix>-audit   append-only action log (item_id + ts)
  <prefix>-lessons analyst lessons learned
  <prefix>-gl-status ledger status overrides written by the GL mock
  <prefix>-notices extracted counterparty notices, written by the IDP hook

`notices` is clearable by that same rule: nothing declares its rows, so they are runtime output of the
document pipeline like everything else on the list. Were a Terraform-declared fixture ever added to it, dropping
those rows would leave the next `terraform plan` proposing to recreate them, and the table would have
to move to the excluded side.

The cost of clearing it is real and accepted: after a reset the actual side is empty until a document is
uploaded again. That is already the documented first step of a demo (see data/README.md), so a reset
leaves the environment in the same state a fresh apply does rather than in a third state of its own.

Usage:
  AWS_PROFILE=<your-profile> python3 infra/scripts/reset_runtime_data.py --prefix recon-dev --apply

Without `--apply` it only counts, so the destructive step is never the default.
"""

from __future__ import annotations

import argparse
import sys

import boto3

# Suffixes of the tables that hold accumulated runtime output. `notices` belongs here because nothing
# declares its rows — they are extraction output like everything else in this list.
CLEARABLE_SUFFIXES: tuple[str, ...] = ("cases", "items", "audit", "lessons", "gl-status", "notices")

# A reset is irreversible, so it refuses to run against anything that does not look like a
# throwaway environment. This is a guard against a mistyped --prefix, not a security control.
ALLOWED_ENV_SUFFIXES: tuple[str, ...] = ("-dev", "-test", "-sandbox")


def key_names(*, client, table: str) -> list[str]:
    """Read a table's primary key attribute names from its schema.

    Hard-coding them would silently under-delete if a table ever gains a sort key: the delete would
    be rejected for a missing key attribute rather than deleting the wrong row, but only at runtime.

    :param client: a boto3 DynamoDB client.
    :param table: the table name to describe.
    :returns: the key attribute names, hash key first.
    """
    schema = client.describe_table(TableName=table)["Table"]["KeySchema"]
    return [k["AttributeName"] for k in sorted(schema, key=lambda k: k["KeyType"] != "HASH")]


def clear_table(*, resource, client, table: str, apply: bool) -> int:
    """Count, and optionally delete, every row in one table.

    Scans projecting ONLY the key attributes: the row bodies here contain full IDP extractions and
    reasoning traces, and pulling them across the wire to throw them away would make the scan
    needlessly slow and expensive.

    :param resource: a boto3 DynamoDB service resource.
    :param client: a boto3 DynamoDB client, used for describe_table.
    :param table: the table name to clear.
    :param apply: when False, count only and delete nothing.
    :returns: the number of rows found (and deleted, when apply is True).
    """
    keys = key_names(client=client, table=table)
    tbl = resource.Table(table)
    projection = ", ".join(f"#k{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}

    rows: list[dict] = []
    kwargs: dict = {"ProjectionExpression": projection, "ExpressionAttributeNames": names}
    while True:
        page = tbl.scan(**kwargs)
        rows.extend(page["Items"])
        # A scan returns at most 1 MB per call; without following the cursor a reset would leave
        # rows behind and report success.
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    if apply and rows:
        with tbl.batch_writer() as batch:
            for row in rows:
                batch.delete_item(Key={k: row[k] for k in keys})
    return len(rows)


def main() -> None:
    """Parse arguments, guard the environment, and clear each table.

    :returns: None. A per-table count is printed; a non-throwaway prefix exits non-zero.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True, help="table name prefix, e.g. recon-dev")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--apply", action="store_true", help="actually delete; omit to count only")
    args = parser.parse_args()

    if not args.prefix.endswith(ALLOWED_ENV_SUFFIXES):
        # Fail loudly: a prefix this script does not recognise as throwaway is far more likely to be
        # a typo than a deliberate production reset, and there is no undo.
        raise SystemExit(
            f"refusing to reset {args.prefix!r}: the prefix must end in one of "
            f"{ALLOWED_ENV_SUFFIXES}. This script deletes every row and has no undo."
        )

    client = boto3.client("dynamodb", region_name=args.region)
    resource = boto3.resource("dynamodb", region_name=args.region)

    mode = "DELETING" if args.apply else "counting (dry run — pass --apply to delete)"
    print(f"[reset] {mode} runtime rows under prefix {args.prefix!r} in {args.region}")

    total = 0
    for suffix in CLEARABLE_SUFFIXES:
        table = f"{args.prefix}-{suffix}"
        try:
            count = clear_table(resource=resource, client=client, table=table, apply=args.apply)
        except client.exceptions.ResourceNotFoundException:
            # Not every environment has every table (gl-status only exists with the GL mock), and a
            # missing optional table is not a reset failure.
            print(f"  {table:<26} absent — skipped")
            continue
        total += count
        print(f"  {table:<26} {count} row(s) {'deleted' if args.apply else 'found'}")

    print(
        f"[reset] {total} row(s) total. {args.prefix}-notices left untouched (Terraform-managed)."
    )
    if not args.apply:
        print("[reset] nothing was deleted. Re-run with --apply.")


if __name__ == "__main__":
    sys.exit(main())
