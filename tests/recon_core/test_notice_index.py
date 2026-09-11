"""Tests for the notice search index.

The encoding is where this is subtly wrong or subtly right, so most of these are about ordering rather
than about round-tripping. A sort-key encoding that is merely *plausible* answers range queries with
confidently wrong result sets: the query succeeds, returns rows, and omits or includes the wrong ones.

Two properties carry the design and are asserted directly:

* lexical order IS numeric order, INCLUDING across zero — naive zero-padding fails here, because an
  amount can be a credit and ``"-500.00"`` sorts below ``"1000.00"`` as text while being greater as a
  number;
* an equality probe is exact, not a prefix — searching ``"12"`` must not match a notice whose value is
  ``"123"``.

Both are decided from the VALUE, never from the field's name, which is the whole point of the index: a
field the extraction starts emitting is searchable with no code change anywhere.
"""

from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.notice_index import (
    NoticeSearchIndex,
    SEP,
    flatten_sections,
    postings_for,
    posting_key,
)

TABLE = "recon-notice-search-test"


def _make_table():
    """Create the moto-mocked index table, keyed as the Terraform module declares it.

    :returns: the boto3 Table resource.
    """
    return boto3.resource("dynamodb", region_name="us-east-1").create_table(
        TableName=TABLE,
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


def _sort_key(value: object, *, field: str = "amount", notice_id: str = "n") -> str:
    """The encoded sort key for one value, for ordering assertions.

    :param value: the value to encode.
    :param field: the field name, which never affects the encoding.
    :param notice_id: the notice id appended after the separator.
    :returns: the sort key.
    """
    key = posting_key(field=field, value=value, notice_id=notice_id)
    assert key is not None, f"{value!r} produced no posting"
    return key["search_value"]


# --- encoding ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ordered",
    [
        ["-1000000.00", "-500.00", "-0.01", "0", "0.01", "500.00", "1000000.00"],
        ["0.000001", "0.00001", "1", "9", "10", "99", "100"],
    ],
)
def test_numeric_values_sort_lexically_in_numeric_order(ordered: list[str]) -> None:
    """The property the whole range-query path rests on, asserted across zero.

    Zero-padding alone passes the second case and FAILS the first: `-500.00` sorts below `1000000.00` as
    text. A range query for "amounts above 0" would then silently include every credit.
    """
    keys = [_sort_key(v) for v in ordered]
    assert keys == sorted(keys), f"encoded order diverges from numeric order: {keys}"


def test_iso_dates_sort_lexically_without_special_casing() -> None:
    """ISO-8601 already sorts correctly as text, so dates need no numeric branch and must not take one.

    They are not numbers, so `_encode` falls through to the text path — which is the right answer here
    rather than a lucky one, and is why the encoding can be chosen from the value alone.
    """
    dates = ["2025-12-31", "2026-01-01", "2026-02-02", "2026-11-17"]
    keys = [_sort_key(d, field="notice_date") for d in dates]
    assert keys == sorted(keys)


def test_text_is_casefolded_so_equality_ignores_case() -> None:
    """Equality matching is case-insensitive everywhere else in the platform; the index must agree."""
    assert _sort_key("CINDERMOOR Logistics", field="counterparty") == _sort_key(
        "cindermoor logistics", field="counterparty"
    )


def test_an_absent_or_blank_value_produces_no_posting() -> None:
    """A posting for a value the document did not print would make the field look extracted.

    Absence is what reaches the agent as `fields_unavailable`; indexing it would make the field
    searchable and answer "yes, carried" for a notice that carries nothing.
    """
    assert posting_key(field="cusip", value=None, notice_id="n") is None
    assert posting_key(field="cusip", value="", notice_id="n") is None
    assert posting_key(field="cusip", value="   ", notice_id="n") is None


def test_a_number_too_large_to_encode_falls_back_to_text() -> None:
    """A magnitude that will not fit the fixed width must not be truncated into the wrong sort position.

    Truncating would leave it answering range queries wrongly and silently. Text is the honest fallback:
    it sorts somewhere useless but never claims a numeric position it does not have.
    """
    huge = "9" * 40
    key = _sort_key(huge)
    assert key.startswith(huge)


def test_postings_carry_the_unencoded_value() -> None:
    """A reader must be able to show what the document said without inverting a lossy encoding."""
    items = list(postings_for(notice_id="n1", fields={"counterparty": "CINDERMOOR Ltd"}))
    assert len(items) == 1
    assert items[0]["raw_value"] == "CINDERMOOR Ltd"
    assert items[0]["notice_id"] == "n1"


def test_flatten_sections_takes_the_first_section_on_a_duplicate_key() -> None:
    """Matches `idp_event_to_notice`, which derives a notice's own scalars from sections[0].

    A later section winning would let the index answer a filter with a value the notice's own attributes
    disagree with.
    """
    sections = [
        {"fields": {"amount": "100.00", "fund": "A"}},
        {"fields": {"amount": "999.00", "cusip": "X"}},
    ]
    assert flatten_sections(sections) == {"amount": "100.00", "fund": "A", "cusip": "X"}


# --- querying ---------------------------------------------------------------------------------------


@mock_aws
def test_equality_is_exact_not_a_prefix() -> None:
    """`begins_with` on the value alone would match a longer value; the separator is what prevents it."""
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n-short", fields={"cusip": "12"})
    index.reindex(notice_id="n-long", fields={"cusip": "123"})

    assert index.notice_ids_for(field="cusip", equals="12") == {"n-short"}
    assert index.notice_ids_for(field="cusip", equals="123") == {"n-long"}


@mock_aws
def test_a_range_query_includes_both_bounds() -> None:
    """An upper bound must cover every posting for that value, not stop at the value itself.

    A sort key is `<encoded>#<notice_id>`, so `BETWEEN lo AND hi` without the suffix drops the notices
    sitting exactly on `hi` — an off-by-one that looks like a plausible smaller result set.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    for notice_id, date in [
        ("n-before", "2025-12-31"),
        ("n-low", "2026-01-01"),
        ("n-mid", "2026-01-15"),
        ("n-high", "2026-01-31"),
        ("n-after", "2026-02-01"),
    ]:
        index.reindex(notice_id=notice_id, fields={"notice_date": date})

    hits = index.notice_ids_for(field="notice_date", low="2026-01-01", high="2026-01-31")
    assert hits == {"n-low", "n-mid", "n-high"}


@mock_aws
def test_a_numeric_band_spans_negative_and_positive() -> None:
    """The credit case, end to end through DynamoDB rather than only through the encoder."""
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    for notice_id, amount in [
        ("n-big-credit", "-5000.00"),
        ("n-credit", "-100.00"),
        ("n-zero", "0.00"),
        ("n-debit", "100.00"),
        ("n-big-debit", "5000.00"),
    ]:
        index.reindex(notice_id=notice_id, fields={"amount": amount})

    hits = index.notice_ids_for(field="amount", low="-100.00", high="100.00")
    assert hits == {"n-credit", "n-zero", "n-debit"}


@mock_aws
def test_an_unconstrained_query_raises_rather_than_returning_the_partition() -> None:
    """Returning everything under a field would read to the agent as a successful broad match."""
    _make_table()
    with pytest.raises(ValueError, match="needs an equality or a bound"):
        NoticeSearchIndex(table_name=TABLE).notice_ids_for(field="cusip")


@mock_aws
def test_a_field_nothing_carries_returns_empty_rather_than_raising() -> None:
    """Queried-and-found-nothing is a real answer and must not be confused with a failure."""
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n1", fields={"cusip": "12345AB6"})

    assert index.notice_ids_for(field="isin", equals="US12345AB67") == set()


# --- re-indexing ------------------------------------------------------------------------------------


@mock_aws
def test_reextraction_removes_the_stale_posting() -> None:
    """The reason this is delete-then-write rather than write-only.

    A stale posting is worse than a missing one: it returns a notice that does not say what the search
    claimed. A corrected counterparty must stop being findable under the old value.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n1", fields={"counterparty": "WRONG NAME LTD"})
    index.reindex(notice_id="n1", fields={"counterparty": "RIGHT NAME LTD"})

    assert index.notice_ids_for(field="counterparty", equals="RIGHT NAME LTD") == {"n1"}
    assert index.notice_ids_for(field="counterparty", equals="WRONG NAME LTD") == set()


@mock_aws
def test_reextraction_removes_a_field_the_document_no_longer_carries() -> None:
    """A field dropped by a re-extraction has to be un-indexed, and only the caller knows it existed.

    Postings are partitioned by field name with no index back from notice to posting, so `previous` is
    how the dropped field's partition gets visited at all. Without it the notice stays findable under a
    field it no longer carries.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n1", fields={"cusip": "12345AB6", "amount": "100.00"})
    index.reindex(notice_id="n1", fields={"amount": "100.00"}, previous=["cusip"])

    assert index.notice_ids_for(field="cusip", equals="12345AB6") == set()
    assert index.notice_ids_for(field="amount", equals="100.00") == {"n1"}


@mock_aws
def test_reindexing_is_idempotent() -> None:
    """The retry path. The hook re-raises on an index failure, so a redelivered event runs this again."""
    _make_table()
    table = boto3.resource("dynamodb", region_name="us-east-1").Table(TABLE)
    index = NoticeSearchIndex(table_name=TABLE)
    fields = {"counterparty": "CINDERMOOR LTD", "amount": "100.00", "cusip": "12345AB6"}

    assert index.reindex(notice_id="n1", fields=fields) == 3
    first = table.scan()["Count"]
    assert index.reindex(notice_id="n1", fields=fields) == 3
    assert table.scan()["Count"] == first


@mock_aws
def test_two_notices_sharing_a_value_both_stay_findable() -> None:
    """The notice id is in the sort key precisely so postings do not collide on a shared value."""
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n1", fields={"counterparty": "SHARED OBLIGOR LTD"})
    index.reindex(notice_id="n2", fields={"counterparty": "SHARED OBLIGOR LTD"})

    assert index.notice_ids_for(field="counterparty", equals="SHARED OBLIGOR LTD") == {"n1", "n2"}


@mock_aws
def test_a_batch_larger_than_dynamodbs_limit_is_written_whole() -> None:
    """BatchWriteItem caps at 25 requests, and a notice can carry more fields than that."""
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    fields = {f"field_{i:02d}": f"value_{i:02d}" for i in range(60)}

    assert index.reindex(notice_id="n1", fields=fields) == 60
    assert index.notice_ids_for(field="field_42", equals="value_42") == {"n1"}


@mock_aws
def test_the_separator_is_not_confused_by_a_value_containing_it() -> None:
    """`#` appears in real extracted text, so a value carrying one must not split the key early.

    The separator is ESCAPED out of the encoded value, so it cannot terminate the key early. Without
    that, `"WIRE#001"` and `"WIRE"` encode to `wire#001#n1` and `wire#n2`, and a probe for `"WIRE"`
    matches both.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n1", fields={"reference": f"WIRE{SEP}001"})
    index.reindex(notice_id="n2", fields={"reference": "WIRE"})

    assert index.notice_ids_for(field="reference", equals=f"WIRE{SEP}001") == {"n1"}
    assert index.notice_ids_for(field="reference", equals="WIRE") == {"n2"}


@mock_aws
def test_a_decimal_value_indexes_the_same_as_its_string(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rows read back from DynamoDB carry Decimals where the extractor emitted numeric JSON.

    Both shapes reach `reindex` -- the hook passes what the mapper embedded, and the backfill passes what
    the table returned -- so they have to encode identically or a backfilled notice is findable under a
    different key than a freshly-ingested one.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n-str", fields={"amount": "150800000.0"})
    index.reindex(notice_id="n-dec", fields={"amount": Decimal("150800000.0")})

    assert index.notice_ids_for(field="amount", equals="150800000.0") == {"n-str", "n-dec"}
