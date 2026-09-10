"""Tests for the search_notices handler (moto-mocked DynamoDB)."""

from decimal import Decimal
from pathlib import Path

import pytest
from moto import mock_aws

from backend.notice_tool.handler import handle
from backend.recon_core.notices import Notice, NoticeStore
from tests.recon_core.test_notices import _document_record, _make_notices_table, _tracking_snapshot


@pytest.fixture(autouse=True)
def _notices_table_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the handler at the moto table.

    The handler reads ``os.environ["NOTICES_TABLE"]`` with no default on purpose — a defaulted table
    name would make a misconfigured Lambda query the wrong table and report "found nothing".

    :param monkeypatch: pytest's environment patcher.
    :returns: None.
    """
    monkeypatch.setenv("NOTICES_TABLE", "recon-notices")


def _embedded(**fields: str) -> list[dict]:
    """One embedded section carrying the given extracted fields and nothing promoted.

    :param fields: the extracted field values, as the extractor emits them (strings).
    :returns: an `idp_sections` list with a single section.
    """
    return [
        {
            "section_id": "1",
            "classification": "wire_confirmation",
            "page_ids": [1],
            "fields": dict(fields),
            "confidences": [],
            "mean_confidence": None,
            "alert_count": 0,
        }
    ]


def _seed() -> None:
    """Write two notices of different classes: one with a facility, one whose class has none.

    `facility` and `amount` go in the embedded extraction, which is where every extracted field lives --
    only the index keys are attributes. That is also what makes these fixtures exercise the resolution
    path the agent's filters actually take.

    :returns: None.
    """
    store = NoticeStore(table_name="recon-notices")
    store.put(
        notice=Notice(
            notice_id="NTC-1",
            notice_class="wire_confirmation",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-02",
            reference="WIRE-20260302-EVG",
            idp_sections=_embedded(facility="CINDERMOOR LOGISTICS TL-A $160MM", amount="9640.18"),
            extraction_confidence=Decimal("0.94"),
            confidence_alert_count=0,
        )
    )
    store.put(
        notice=Notice(
            notice_id="NTC-2",
            notice_class="capital_call",  # this class extracts no facility at all
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-05",
            idp_sections=_embedded(amount="400000.00"),
            extraction_confidence=Decimal("0.81"),
            confidence_alert_count=2,
        )
    )


@mock_aws
def test_filtering_on_an_unextracted_field_reports_it_unavailable() -> None:
    """A class that never extracts the field must be annotated, not filtered out."""
    _make_notices_table()
    _seed()
    out = handle(
        {"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.", "facility": "anything"}, None
    )
    returned = {r["notice_id"] for r in out["rows"]}
    assert "NTC-2" in returned, "a notice whose class lacks the field must not be silently dropped"
    row = next(r for r in out["rows"] if r["notice_id"] == "NTC-2")
    assert "facility" in row["fields_unavailable"]


@mock_aws
def test_amount_tolerance_matches_within_the_band() -> None:
    """The amount is matched by the band, never by string equality."""
    _make_notices_table()
    _seed()
    out = handle({"amount": "9640.00", "amount_tolerance": "0.25"}, None)
    assert [r["notice_id"] for r in out["rows"]] == ["NTC-1"]
    assert "amount" in out["matched_on"]


@mock_aws
def test_searched_and_found_nothing_is_an_empty_list_not_an_error() -> None:
    """An empty result is a successful search with no hits."""
    _make_notices_table()
    _seed()
    out = handle({"reference": "WIRE-DOES-NOT-EXIST"}, None)
    assert out["rows"] == []
    assert out["truncated"] is False


@mock_aws
def test_every_row_carries_the_confidence_attributes() -> None:
    """Every stored row carries these, so their absence downstream is a bug."""
    # Because EVERY row has these, their absence is a bug, not an expected case.
    _make_notices_table()
    _seed()
    out = handle({"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC."}, None)
    for row in out["rows"]:
        assert "extraction_confidence" in row
        assert "confidence_alert_count" in row


def test_read_failure_raises_rather_than_returning_no_rows() -> None:
    """A throttle or a missing table must never look like "found nothing"."""

    class Exploding:
        """A table stand-in whose query raises, standing in for a throttle or a missing table."""

        def query(self, **_kwargs: object) -> dict[str, object]:
            """Always fail.

            :returns: never returns.
            :raises RuntimeError: always.
            """
            raise RuntimeError("ProvisionedThroughputExceededException")

    with pytest.raises(RuntimeError, match="search_notices"):
        handle({"reference": "WIRE-1"}, None, ddb=Exploding())


def test_the_two_sides_cannot_return_each_others_rows() -> None:
    """search_notices reads only DynamoDB; search_ledger reads only Athena + its own overlay.

    Asserted at the source level rather than by comparing result sets, because a union tool returning
    both sides would satisfy any row-level assertion — the point is that neither handler has a code
    path to the other's store.

    Note the ledger assertion names the notices TABLE, not DynamoDB: ``gl_tool/handler.py`` reads a
    DynamoDB status overlay of its own side (``GL_STATUS_TABLE``), which is legitimate. What it must
    never read is the notice store.
    """
    root = Path(__file__).resolve().parents[2]
    notice_src = (root / "backend/notice_tool/handler.py").read_text().lower()
    ledger_src = (root / "backend/gl_tool/handler.py").read_text().lower()
    assert "athena" not in notice_src
    assert "notices" not in ledger_src
    assert "notice_id" not in ledger_src


@mock_aws
def test_a_row_without_an_activity_type_is_annotated_not_excluded() -> None:
    """An aggregated advice legitimately has no single activity, and that is not a non-match.

    This is the class-dependent contract: the caller asked about a field this notice does not carry, so
    the row comes back with the field named in `fields_unavailable`. Excluding it instead would hide the
    consolidated-wire case from exactly the query that should find it. A row carrying a DIFFERENT
    activity is excluded, because that is a real mismatch rather than an absence.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    common = {
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "notice_date": "2026-03-02",
        "extraction_confidence": Decimal("0.9"),
        "confidence_alert_count": 0,
    }
    store.put(notice=Notice(notice_id="NTC-AGG", notice_class="remittance_advice", **common))
    store.put(
        notice=Notice(
            notice_id="NTC-INT",
            notice_class="wire_confirmation",
            idp_sections=_embedded(activity_type="Interest"),
            **common,
        )
    )

    out = handle(
        {"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.", "activity_type": "Rollover"},
        None,
    )
    assert {row["notice_id"] for row in out["rows"]} == {"NTC-AGG"}
    assert out["rows"][0]["fields_unavailable"] == ["activity_type"]


@mock_aws
def test_a_dateless_notice_is_annotated_not_silently_excluded() -> None:
    """The regression that would otherwise turn a loud dead-letter into an invisible row.

    `notice_date` is optional, so a dateless notice is stored. Comparing the bounds against a defaulted
    `""` would sort it below every ISO date, so a `date_from` bound alone would drop every such row from
    every bounded search with nothing reporting it — a disappearance, which is worse than a dead-letter
    because there is no error either.

    Two halves, and the second is what makes the row safe to return: it comes back, AND it comes back
    carrying `notice_date` in `fields_unavailable`, so the agent knows the date window it asked about
    was never actually checked against this row.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    common = {
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "extraction_confidence": Decimal("0.9"),
        "confidence_alert_count": 0,
    }
    # Dateless: reachable only by the scan path while counterparty-index still keys on notice_date,
    # because DynamoDB drops an item with no range key from that index. Asserted via the scan path.
    store.put(notice=Notice(notice_id="NTC-NODATE", notice_class="incomplete_notice", **common))
    store.put(
        notice=Notice(
            notice_id="NTC-DATED",
            notice_class="wire_confirmation",
            notice_date="2026-03-02",
            **common,
        )
    )

    out = handle({"date_from": "2026-03-01", "date_to": "2026-03-31"}, None)

    by_id = {row["notice_id"]: row for row in out["rows"]}
    assert "NTC-NODATE" in by_id, "a dateless notice was silently dropped from a bounded search"
    assert by_id["NTC-NODATE"]["fields_unavailable"] == ["notice_date"]
    # The dated row is inside the window, so nothing is unavailable about it.
    assert by_id["NTC-DATED"]["fields_unavailable"] == []
    assert "notice_date" in out["matched_on"]


@mock_aws
def test_a_dated_notice_outside_the_window_is_still_excluded() -> None:
    """The other half of the pair: tolerating an ABSENT date must not tolerate a WRONG one.

    Guards the obvious over-correction — replacing the unconditional comparison with one that skips
    whenever the value is falsy, or dropping the bounds entirely. A notice that carries a date outside
    the window is a real mismatch, not an absence, and must not come back.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(
        notice=Notice(
            notice_id="NTC-OLD",
            notice_class="wire_confirmation",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2025-01-15",
            extraction_confidence=Decimal("0.9"),
            confidence_alert_count=0,
        )
    )

    out = handle({"date_from": "2026-03-01", "date_to": "2026-03-31"}, None)

    assert out["rows"] == []


@mock_aws
def test_a_field_only_in_idp_sections_is_filterable() -> None:
    """The point of dynamic resolution: no allowlist, and no code change per field.

    `cusip` is not a Notice attribute and appears in no filter list — it lives only inside
    `idp_sections[].fields`. Filtering on it must select correctly, which is what proves a field the
    pipeline starts extracting tomorrow is searchable tomorrow with no edit here.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    common = {
        "notice_class": "wire_confirmation",
        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
        "notice_date": "2026-03-02",
        "extraction_confidence": Decimal("0.9"),
        "confidence_alert_count": 0,
    }
    store.put(notice=Notice(notice_id="NTC-A", idp_sections=_embedded(cusip="12345AB6"), **common))
    store.put(notice=Notice(notice_id="NTC-B", idp_sections=_embedded(cusip="99999ZZ9"), **common))

    out = handle({"counterparty": common["counterparty"], "cusip": "12345AB6"}, None)

    assert {r["notice_id"] for r in out["rows"]} == {"NTC-A"}
    # And it must NOT be reported unavailable: the row carries it, just not at the top level. Testing
    # `name not in raw` would call it unavailable and the agent would stop looking for it.
    assert out["rows"][0]["fields_unavailable"] == []
    assert "cusip" in out["matched_on"]


@mock_aws
def test_the_amount_band_resolves_from_idp_sections() -> None:
    """The tolerance band has to work on an amount that is only in the extraction.

    The extraction stores what the document printed, as a STRING, so this also pins the numeric coercion
    in `_as_decimal`.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    common = {
        "notice_class": "wire_confirmation",
        "counterparty": "MISTFELL FOODS CORP.",
        "notice_date": "2026-03-02",
        "extraction_confidence": Decimal("0.9"),
        "confidence_alert_count": 0,
    }
    store.put(notice=Notice(notice_id="NTC-IN", idp_sections=_embedded(amount="1000.25"), **common))
    store.put(
        notice=Notice(notice_id="NTC-OUT", idp_sections=_embedded(amount="8500.00"), **common)
    )

    out = handle(
        {
            "counterparty": common["counterparty"],
            "amount": "1000.00",
            "amount_tolerance": "0.50",
        },
        None,
    )

    assert {r["notice_id"] for r in out["rows"]} == {"NTC-IN"}


@mock_aws
def test_a_field_carried_nowhere_is_still_annotated_not_excluded() -> None:
    """Dynamic resolution must not lose the class-dependent contract it replaced.

    The row carries `cusip` neither top-level nor embedded, so it comes back annotated rather than
    filtered out — the same guarantee the old `CLASS_DEPENDENT_FIELDS` allowlist gave, now applied to
    every field name instead of six.
    """
    _make_notices_table()
    NoticeStore(table_name="recon-notices").put(
        notice=Notice(
            notice_id="NTC-BARE",
            notice_class="incomplete_notice",
            counterparty="PARTIAL FAX COVER LLP",
            notice_date="2026-03-02",
            extraction_confidence=Decimal("0.9"),
            confidence_alert_count=0,
        )
    )

    out = handle({"counterparty": "PARTIAL FAX COVER LLP", "cusip": "12345AB6"}, None)

    assert [r["notice_id"] for r in out["rows"]] == ["NTC-BARE"]
    assert out["rows"][0]["fields_unavailable"] == ["cusip"]


@mock_aws
def test_a_promoted_attribute_wins_over_the_embedded_copy() -> None:
    """An index key exists as both an attribute and an extracted field, and the attribute must win.

    The attribute is the value the GSI was built from and the one the mapper normalised. A filter that
    matched the embedded copy while the index disagreed would make retrieval depend on which access path
    the query happened to take.
    """
    _make_notices_table()
    NoticeStore(table_name="recon-notices").put(
        notice=Notice(
            notice_id="NTC-BOTH",
            notice_class="wire_confirmation",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-02",
            reference="WIRE-1",
            idp_sections=_embedded(fund="Direct Lending Fund I"),
            extraction_confidence=Decimal("0.9"),
            confidence_alert_count=0,
        )
    )

    hit = handle({"fund": "Direct Lending Fund I"}, None)
    miss = handle({"fund": "A DIFFERENT FUND"}, None)

    assert [r["notice_id"] for r in hit["rows"]] == ["NTC-BOTH"]
    assert miss["rows"] == []


@mock_aws
def test_per_field_confidences_are_not_returned_to_the_model() -> None:
    """The sections the tool returns carry the content and drop the pipeline bookkeeping.

    `confidences` is 72% of `idp_sections` and 39% of a whole row on the live corpus, and the model cannot
    act on a per-field score: what gates the agent is the notice-level extraction_confidence /
    confidence_alert_count pair, which is the same number the gateway interceptor refuses ledger writes
    on. Unlike `idp_pages` this cannot be withheld wholesale -- `fields` IS the notice's payload now that
    extracted content is not a top-level attribute -- so it is projected instead.
    """
    _make_notices_table()
    section = {
        "section_id": "1",
        "classification": "wire_confirmation",
        "page_ids": [1, 2],
        "fields": {"amount": "9640.18", "cusip": "12345AB6"},
        "confidences": [
            {"field": "amount", "confidence": Decimal("0.95"), "threshold": Decimal("0.8")}
        ],
        "mean_confidence": Decimal("0.95"),
        "alert_count": 0,
    }
    NoticeStore(table_name="recon-notices").put(
        notice=Notice(
            notice_id="NTC-TRIM",
            notice_class="wire_confirmation",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-02",
            idp_sections=[section],
            extraction_confidence=Decimal("0.94"),
            confidence_alert_count=0,
        )
    )

    out = handle({"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC."}, None)

    returned = out["rows"][0]["idp_sections"][0]
    assert set(returned) == {"classification", "fields"}
    assert returned["fields"] == {"amount": "9640.18", "cusip": "12345AB6"}
    # The notice-level pair the agent IS gated on survives.
    assert out["rows"][0]["extraction_confidence"] == Decimal("0.94")
    assert out["rows"][0]["confidence_alert_count"] == 0


@mock_aws
def test_trimming_sections_does_not_change_what_matches() -> None:
    """The projection is applied to the OUTPUT row only, never to what the filters read.

    Trimming `raw` before `_matches`/`_unavailable` ran would silently change which rows come back and
    what is reported unavailable -- a filter on a field the projection dropped would find nothing and be
    annotated as not carried, on a row that carries it.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    common = {
        "notice_class": "wire_confirmation",
        "counterparty": "MISTFELL FOODS CORP.",
        "notice_date": "2026-03-02",
        "extraction_confidence": Decimal("0.9"),
        "confidence_alert_count": 0,
    }
    store.put(
        notice=Notice(notice_id="NTC-HIT", idp_sections=_embedded(cusip="12345AB6"), **common)
    )
    store.put(
        notice=Notice(notice_id="NTC-MISS", idp_sections=_embedded(cusip="99999ZZ9"), **common)
    )

    out = handle({"counterparty": "MISTFELL FOODS CORP.", "cusip": "12345AB6"}, None)

    assert [r["notice_id"] for r in out["rows"]] == ["NTC-HIT"]
    assert out["rows"][0]["fields_unavailable"] == []


@mock_aws
def test_page_images_are_never_returned_to_the_model() -> None:
    """`idp_pages` is stored for the case screen, which reads the table directly.

    A notice now carries around thirty attributes; handing the model page-image S3 locations on top of
    them spends its context on data it cannot act on. This tool returns the matchable projection of a
    notice, not the stored row — asserted here because the withholding is invisible from the model side.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(
        notice=Notice(
            notice_id="NTC-PAGES",
            notice_class="wire_confirmation",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-02",
            idp_pages=[{"page": 1, "uri": "s3://bucket/page1.jpg"}],
            extraction_confidence=Decimal("0.9"),
            confidence_alert_count=0,
        )
    )

    out = handle({"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC."}, None)
    assert out["rows"], "the row itself must still be returned"
    assert "idp_pages" not in out["rows"][0]
    # And it IS on the stored item — otherwise this test would pass on a notice that never had one.
    assert "idp_pages" in store.raw(notice_id="NTC-PAGES")


@mock_aws
def test_tracking_row_is_excluded_from_the_scan_path() -> None:
    """No selective hint forces a table scan; the record_kind guard must still apply there.

    _matches is the single choke point for both the scan and the indexed-query path, so this test
    and test_tracking_row_is_excluded_from_the_indexed_query_path together prove it runs on both.
    """
    _make_notices_table()
    _seed()
    store = NoticeStore(table_name="recon-notices")
    store.put_document_record(record=_document_record())

    out = handle({}, None)
    returned = {r["notice_id"] for r in out["rows"]}
    assert returned == {"NTC-1", "NTC-2"}
    assert "idp-inbox/2026/03/01/wire-0007.pdf" not in returned


@mock_aws
def test_tracking_row_is_excluded_from_the_indexed_query_path() -> None:
    """The FILTER excludes a tracking row, not the index merely lacking it.

    The tracking row is seeded with a `counterparty` AND `notice_date` it would not normally carry
    (a real FAILED-before-extraction row has neither), specifically so it lands INSIDE
    counterparty-index. If `_matches` did not exclude it, the query would return it; the assertion
    that it is absent therefore proves the filter did the work, not an accident of what the GSI
    happens to contain.
    """
    _make_notices_table()
    _seed()
    store = NoticeStore(table_name="recon-notices")
    store.put_document_record(
        record=_document_record(
            notice_id="idp-inbox/2026/03/09/tracking-only.pdf",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-09",
        )
    )

    out = handle({"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC."}, None)
    returned = {r["notice_id"] for r in out["rows"]}
    assert "idp-inbox/2026/03/09/tracking-only.pdf" not in returned
    assert returned == {"NTC-1", "NTC-2"}


@mock_aws
def test_a_row_with_no_record_kind_attribute_is_still_returned() -> None:
    """Absence of `record_kind` must mean "notice" -- every row written before the field existed.

    Written directly with `table.put_item`, bypassing both `Notice` (whose `record_kind` field
    defaults to `"notice"` and would always be present in the dump) and `put_document_record`
    (which requires `record_kind == "document"`), because neither path can produce the one shape
    this test needs: a real row that predates the attribute entirely.
    """
    table = _make_notices_table()
    table.put_item(
        Item={
            "notice_id": "NTC-LEGACY",
            "notice_class": "wire_confirmation",
            "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
            "notice_date": "2026-03-01",
            "extraction_confidence": Decimal("0.9"),
            "confidence_alert_count": 0,
        }
    )

    out = handle({"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC."}, None)
    assert {r["notice_id"] for r in out["rows"]} == {"NTC-LEGACY"}


@mock_aws
def test_idp_bookkeeping_fields_are_withheld_but_still_stored() -> None:
    """`record_kind`, `idp_record`, `idp_started_at` and `idp_tracking` never reach the model.

    Asserted against a row that DOES carry all four (via `store.raw()`) rather than one that never
    had them, so this test would fail if a future change stopped writing them instead of merely
    passing by accident.
    """
    _make_notices_table()
    store = NoticeStore(table_name="recon-notices")
    store.put(
        notice=Notice(
            notice_id="NTC-TRACKED",
            notice_class="wire_confirmation",
            counterparty="CINDERMOOR LOGISTICS HOLDINGS INC.",
            notice_date="2026-03-02",
            idp_tracking=_tracking_snapshot(),
            extraction_confidence=Decimal("0.9"),
            confidence_alert_count=0,
        )
    )

    out = handle({"counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC."}, None)
    row = next(r for r in out["rows"] if r["notice_id"] == "NTC-TRACKED")
    withheld = ("record_kind", "idp_record", "idp_started_at", "idp_tracking")
    for name in withheld:
        assert name not in row

    raw = store.raw(notice_id="NTC-TRACKED")
    for name in withheld:
        assert name in raw
