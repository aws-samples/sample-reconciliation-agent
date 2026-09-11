"""Tests for scripts/backfill_notice_search_index.py.

The counts this script prints are the whole point of it: a notice with no postings is invisible to every
field search while looking perfectly healthy in the notices table and on the Documents tab, so "how many
rows could not be indexed, and which" is the only signal an operator gets. These tests are mostly about
that reporting being honest rather than about the writing, which `test_notice_index.py` covers.
"""

from decimal import Decimal

import boto3
from moto import mock_aws

from backend.recon_core.notice_index import NoticeSearchIndex
from scripts.backfill_notice_search_index import backfill

NOTICES = "recon-notices-backfill"
INDEX = "recon-notice-search-backfill"


def _make_tables():
    """Create both moto-mocked tables.

    :returns: ``(notices_table, index_table)``.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    notices = ddb.create_table(
        TableName=NOTICES,
        KeySchema=[{"AttributeName": "notice_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "notice_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    index = ddb.create_table(
        TableName=INDEX,
        KeySchema=[
            {"AttributeName": "search_field", "KeyType": "HASH"},
            {"AttributeName": "search_value", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "search_field", "AttributeType": "S"},
            {"AttributeName": "search_value", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return notices, index


def _row(notice_id: str, *, fields: dict | None = None, **extra) -> dict:
    """One notices-table row with its extraction embedded where the real ones carry it.

    :param notice_id: the row's key.
    :param fields: extracted fields to embed as a single section, or None for a row with no sections.
    :param extra: further top-level attributes, e.g. ``record_kind``.
    :returns: the item to put.
    """
    item: dict = {"notice_id": notice_id, **extra}
    if fields is not None:
        item["idp_sections"] = [{"section_id": "1", "fields": fields}]
    return item


def _run(notices, index, *, dry_run: bool = False) -> dict[str, int]:
    """Invoke the backfill against the moto tables.

    :param notices: the notices Table resource.
    :param index: the index Table resource.
    :param dry_run: passed through.
    :returns: the counts the backfill reports.
    """
    return backfill(
        table=notices,
        index=NoticeSearchIndex(table_name=INDEX, ddb=index),
        dry_run=dry_run,
    )


@mock_aws
def test_backfill_indexes_every_extracted_field() -> None:
    """The happy path, and the count it reports has to be the number actually written."""
    notices, index = _make_tables()
    notices.put_item(Item=_row("n1", fields={"counterparty": "CINDERMOOR LTD", "amount": "100.00"}))
    notices.put_item(Item=_row("n2", fields={"counterparty": "MISTFELL CORP"}))

    counts = _run(notices, index)

    assert counts["notices"] == 2
    assert counts["postings"] == 3
    assert index.scan()["Count"] == 3
    search = NoticeSearchIndex(table_name=INDEX, ddb=index)
    assert search.notice_ids_for(field="counterparty", equals="CINDERMOOR LTD") == {"n1"}


@mock_aws
def test_a_tracking_only_row_is_skipped_and_counted() -> None:
    """Tracking rows are pipeline plumbing that `search_notices` already discards.

    Indexing them would put ids in the index the reader is obliged to throw away. Counted separately from
    the unindexable notices, because they are an expected category rather than a gap to chase.
    """
    notices, index = _make_tables()
    notices.put_item(Item=_row("n1", fields={"counterparty": "CINDERMOOR LTD"}))
    notices.put_item(Item=_row("doc1", record_kind="document", notice_failure_reason="no date"))

    counts = _run(notices, index)

    assert counts["notices"] == 1
    assert counts["tracking_rows"] == 1
    assert counts["no_fields"] == 0
    assert index.scan()["Count"] == 1


@mock_aws
def test_a_row_with_no_record_kind_is_treated_as_a_notice() -> None:
    """The rows this backfill exists for are exactly the ones written before `record_kind` existed.

    A truthiness test on the attribute would exclude every one of them -- the script would report a clean
    run having indexed nothing.
    """
    notices, index = _make_tables()
    notices.put_item(Item=_row("legacy", fields={"counterparty": "OLD ROW LTD"}))

    counts = _run(notices, index)

    assert counts["notices"] == 1
    assert counts["tracking_rows"] == 0


@mock_aws
def test_a_notice_with_no_extracted_fields_is_reported_not_silently_skipped(capsys) -> None:
    """The number and the ids both matter: an operator cannot chase what the script will not name."""
    notices, index = _make_tables()
    notices.put_item(Item=_row("n1", fields={"counterparty": "CINDERMOOR LTD"}))
    notices.put_item(Item=_row("bare-1"))
    notices.put_item(Item=_row("bare-2", fields={}))

    counts = _run(notices, index)

    assert counts["notices"] == 1
    assert counts["no_fields"] == 2
    out = capsys.readouterr().out
    assert "bare-1" in out and "bare-2" in out
    assert "not\nsearchable by field" in out or "searchable by field" in out


@mock_aws
def test_dry_run_writes_nothing_but_still_reports_the_real_count() -> None:
    """A dry run that under-reported would make the real run look like it did more than expected."""
    notices, index = _make_tables()
    notices.put_item(Item=_row("n1", fields={"counterparty": "CINDERMOOR LTD", "amount": "100.00"}))

    counts = _run(notices, index, dry_run=True)

    assert counts["postings"] == 2
    assert index.scan()["Count"] == 0


@mock_aws
def test_running_twice_converges_rather_than_duplicating() -> None:
    """Re-runnability is what makes this safe to point at a live table after a partial failure."""
    notices, index = _make_tables()
    notices.put_item(Item=_row("n1", fields={"counterparty": "CINDERMOOR LTD", "amount": "100.00"}))

    _run(notices, index)
    first = index.scan()["Count"]
    _run(notices, index)

    assert index.scan()["Count"] == first


@mock_aws
def test_a_decimal_amount_from_the_table_indexes_like_the_string_the_hook_writes() -> None:
    """The backfill and the hook must produce the SAME posting for the same notice.

    The hook passes what the mapper embedded (strings, mostly); a scan returns Decimals wherever the
    stored value was numeric. Encoding them differently would make a backfilled notice findable under a
    different key than a freshly-ingested one, which is invisible until a search misses.
    """
    notices, index = _make_tables()
    notices.put_item(Item=_row("n-dec", fields={"amount": Decimal("9640.18")}))

    _run(notices, index)

    search = NoticeSearchIndex(table_name=INDEX, ddb=index)
    assert search.notice_ids_for(field="amount", equals="9640.18") == {"n-dec"}


@mock_aws
def test_the_scan_follows_pagination() -> None:
    """A single Scan page caps at 1 MB, so a table larger than that would be silently half-indexed."""
    notices, index = _make_tables()
    # Padded so the rows are large enough that moto pages them, rather than trusting a small fixture.
    for i in range(120):
        notices.put_item(
            Item=_row(f"n{i:03d}", fields={"counterparty": f"OBLIGOR {i:03d} {'x' * 400}"})
        )

    counts = _run(notices, index)

    assert counts["notices"] == 120
    assert index.scan()["Count"] == 120
