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
    ALL_FIELD,
    NoticeSearchIndex,
    RESERVED_PREFIX,
    SEP,
    flatten_sections,
    indexable_fields,
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
    items = [
        i
        for i in postings_for(notice_id="n1", fields={"counterparty": "CINDERMOOR Ltd"})
        if i["search_field"] != ALL_FIELD
    ]
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


def test_indexable_fields_layers_the_normalised_index_keys_over_the_sections() -> None:
    """The promoted attribute WINS, and that precedence is the point.

    Those three attributes hold a value the raw extraction does not: the mapper resolves `borrower` to
    `counterparty`, `value_date` to `notice_date`, and a missing obligor to `"unknown"`. Indexing the
    sections alone leaves such a notice findable under `borrower` and not under `counterparty`, and an
    unattributable one findable under neither — invisible to the agent's primary lookup.
    """
    row = {
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS, INC.",  # normalised from `borrower`
        "notice_date": "2026-02-02",  # normalised from `value_date`
        "idp_sections": [
            {
                "fields": {
                    "borrower": "CINDERMOOR LOGISTICS",
                    "value_date": "2026-02-02",
                    "cusip": "X",
                }
            }
        ],
    }
    out = indexable_fields(row)
    assert out["counterparty"] == "CINDERMOOR LOGISTICS HOLDINGS, INC."
    assert out["notice_date"] == "2026-02-02"
    # The raw extraction is still indexed alongside it, so the document's own wording stays searchable.
    assert out["borrower"] == "CINDERMOOR LOGISTICS"
    assert out["cusip"] == "X"


def test_indexable_fields_omits_an_index_key_the_row_does_not_carry() -> None:
    """`reference` is genuinely absent on most classes; a None must not become a posting."""
    out = indexable_fields({"counterparty": "X", "idp_sections": [{"fields": {"amount": "1.00"}}]})
    assert "reference" not in out
    assert sorted(out) == ["amount", "counterparty"]


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

    # 3 field postings + the all-notices posting.
    assert index.reindex(notice_id="n1", fields=fields) == 4
    first = table.scan()["Count"]
    assert index.reindex(notice_id="n1", fields=fields) == 4
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

    assert index.reindex(notice_id="n1", fields=fields) == 61  # 60 fields + all-notices
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


# --- absence, which is what makes a generic soft filter possible ------------------------------------


@mock_aws
def test_the_notices_lacking_a_field_are_computable() -> None:
    """The construction the whole generic reader rests on, asserted directly.

    A posting list holds only the notices that DO carry a field, so absence is not expressible in it.
    `all_notice_ids() - notice_ids_with_field(X)` is its complement, and that is what lets a filter stay
    SOFT -- a notice missing the field annotated rather than excluded -- without naming any extracted
    field in code.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n-full", fields={"counterparty": "A LTD", "cusip": "X1"})
    index.reindex(notice_id="n-bare", fields={"counterparty": "B LTD"})

    assert index.all_notice_ids() == {"n-full", "n-bare"}
    assert index.notice_ids_with_field(field="cusip") == {"n-full"}
    assert index.all_notice_ids() - index.notice_ids_with_field(field="cusip") == {"n-bare"}


@mock_aws
def test_a_notice_that_extracted_nothing_still_joins_the_all_partition() -> None:
    """Otherwise `all - present(X)` under-reports, and a soft filter EXCLUDES a row it must annotate.

    A fieldless notice is real: the corpus fax cover carries a counterparty and an agent bank and nothing
    a filter is likely to name. It has to be in `all` or it silently disappears from every filtered search
    rather than coming back annotated.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    assert index.reindex(notice_id="n-empty", fields={}) == 1  # the all-notices posting alone

    assert index.all_notice_ids() == {"n-empty"}
    assert index.notice_ids_with_field(field="cusip") == set()


@mock_aws
def test_the_soft_filter_construction_reproduces_annotate_dont_exclude() -> None:
    """End to end: the set algebra `search_notices` will use, on notices with mixed field coverage.

    `n-other` carries a DIFFERENT activity_type and must be excluded -- a real mismatch. `n-none` carries
    none and must be kept. Getting this backwards is the fail-quiet outcome: the consolidated-wire case
    disappears from exactly the query meant to find it.
    """
    _make_table()
    index = NoticeSearchIndex(table_name=TABLE)
    index.reindex(notice_id="n-match", fields={"activity_type": "Rollover"})
    index.reindex(notice_id="n-other", fields={"activity_type": "Interest"})
    index.reindex(notice_id="n-none", fields={"amount": "1.00"})

    matched = index.notice_ids_for(field="activity_type", equals="Rollover")
    lacking = index.all_notice_ids() - index.notice_ids_with_field(field="activity_type")

    assert matched == {"n-match"}
    assert lacking == {"n-none"}
    assert (matched | lacking) == {"n-match", "n-none"}


def test_a_field_using_recons_reserved_prefix_is_rejected() -> None:
    """Silent collision would make every notice look like it matched everything.

    A field literally named `#all` would merge its postings into the all-notices partition, so
    `all_notice_ids()` would return notices keyed by that field's VALUES. Raising is the only safe
    response -- recon cannot store the field, and pretending otherwise corrupts every soft filter.
    """
    with pytest.raises(ValueError, match="reserved prefix"):
        list(postings_for(notice_id="n1", fields={f"{RESERVED_PREFIX}all": "v"}))
