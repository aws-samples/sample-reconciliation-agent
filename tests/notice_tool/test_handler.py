"""Tests for the search_notices handler (moto-mocked DynamoDB)."""

from decimal import Decimal
from pathlib import Path

import pytest
from moto import mock_aws

from backend.notice_tool.handler import handle
from backend.recon_core.notices import Notice, NoticeStore
from tests.recon_core.test_notices import _make_notices_table


@pytest.fixture(autouse=True)
def _notices_table_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the handler at the moto table.

    The handler reads ``os.environ["NOTICES_TABLE"]`` with no default on purpose — a defaulted table
    name would make a misconfigured Lambda query the wrong table and report "found nothing".

    :param monkeypatch: pytest's environment patcher.
    :returns: None.
    """
    monkeypatch.setenv("NOTICES_TABLE", "recon-notices")


def _seed() -> None:
    """Write two notices of different classes: one with a facility, one whose class has none.

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
            facility="CINDERMOOR LOGISTICS TL-A $160MM",
            amount=Decimal("9640.18"),
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
            amount=Decimal("400000.00"),
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
            activity_type="Interest",
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
