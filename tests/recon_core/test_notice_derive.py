"""Tests for the notice derivations.

Both functions are pure, so these tests are cheap — which matters, because each one guards a mistake
that is invisible downstream. A finalisation status read as False when it was unreadable turns a
contract break into evidence; a mis-converted serial shifts a notice out of its own match window.
"""

import pytest

from backend.recon_core.notice_derive import (
    excel_serial_to_iso,
    is_source_finalized,
)

# --- is_source_finalized --------------------------------------------------------------------------


def test_a_reviewed_structured_feed_record_is_finalized() -> None:
    """The one True case."""
    assert (
        is_source_finalized(source_system="STRUCTURED_FEED", source_status_raw="Reviewed") is True
    )


def test_a_new_structured_feed_record_is_not_finalized() -> None:
    """`New` is the source saying so, which is evidence rather than an error."""
    assert is_source_finalized(source_system="STRUCTURED_FEED", source_status_raw="New") is False


@pytest.mark.parametrize("system", ["OTHER", None, ""])
def test_a_non_structured_feed_record_is_never_finalized_and_never_raises(system) -> None:
    """Every notice on the document path takes this branch, so it must not raise.

    Finalisation is a property the structured feed has and the document path does not. Raising here
    would break the ONLY path that currently produces notices.

    :param system: a source_system that is not STRUCTURED_FEED.
    """
    assert is_source_finalized(source_system=system, source_status_raw=None) is False


@pytest.mark.parametrize("status", [None, ""])
def test_a_structured_feed_record_without_a_status_raises(status) -> None:
    """A record claiming structured-feed provenance with no status is a contract break, not a negative.

    :param status: an absent or blank status.
    """
    with pytest.raises(ValueError, match="no source_status_raw"):
        is_source_finalized(source_system="STRUCTURED_FEED", source_status_raw=status)


@pytest.mark.parametrize("status", ["reviewed", "REVIEWED", "Final", "Approved"])
def test_an_unrecognised_structured_feed_status_raises(status) -> None:
    """Including case variants: the comparison is exact, so `reviewed` is not `Reviewed`.

    Returning False for an unreadable status would let a real `Reviewed` record whose casing drifted
    read as not-finalised, which is a silent downgrade rather than a visible failure.

    :param status: a status outside the known set.
    """
    with pytest.raises(ValueError, match="unrecognised source_status_raw"):
        is_source_finalized(source_system="STRUCTURED_FEED", source_status_raw=status)


# --- excel_serial_to_iso --------------------------------------------------------------------------


def test_the_serial_for_the_cuj_example_date() -> None:
    """2026-07-18 is serial 46221, and the CUJ document's own example says 46230. It is wrong.

    Asserted explicitly, with the document's figure asserted separately below, so that a reader who
    notices the discrepancy finds it decided here rather than "correcting" the converter.
    """
    assert excel_serial_to_iso("46221") == "2026-07-18"


def test_the_cuj_documents_serial_converts_to_its_real_date() -> None:
    """46230 is 2026-07-27 under the 1900 system, and under no epoch is it 2026-07-18."""
    assert excel_serial_to_iso("46230") == "2026-07-27"


def test_serial_one_is_the_epoch() -> None:
    """Serial 1 is 1900-01-01 — the below-the-phantom branch's boundary."""
    assert excel_serial_to_iso("1") == "1900-01-01"


def test_the_day_before_the_phantom() -> None:
    """Serial 59 is 1900-02-28, the last date the pre-phantom epoch applies to."""
    assert excel_serial_to_iso("59") == "1900-02-28"


def test_the_day_after_the_phantom_uses_the_shifted_epoch() -> None:
    """Serial 61 is 1900-03-01. A single epoch for both branches puts this a day out.

    This is the whole 1900 leap-year artefact in one assertion: naively adding 61 days to 1899-12-31
    yields 1900-03-02, and every date after it inherits that one-day error.
    """
    assert excel_serial_to_iso("61") == "1900-03-01"


def test_the_phantom_serial_raises() -> None:
    """Serial 60 is Excel's 1900-02-29, which never existed and has no honest conversion."""
    with pytest.raises(ValueError, match="phantom"):
        excel_serial_to_iso("60")


@pytest.mark.parametrize("serial", ["0", "-1", "100001", "999999"])
def test_an_implausible_serial_raises(serial) -> None:
    """Out-of-range values are far more likely an amount or an identifier than a date (DT7).

    :param serial: a serial outside [1, 100000].
    """
    with pytest.raises(ValueError, match="outside the plausible range"):
        excel_serial_to_iso(serial)


@pytest.mark.parametrize("serial", ["", "not-a-date", "2026-07-18", "46221.5"])
def test_a_non_integer_serial_raises(serial) -> None:
    """An already-ISO date reaching this function means a caller did not check; say so loudly.

    :param serial: a value that is not an integer.
    """
    with pytest.raises(ValueError, match="not an integer"):
        excel_serial_to_iso(serial)


def test_surrounding_whitespace_is_tolerated() -> None:
    """Spreadsheet cells carry stray whitespace, and that is not a data error worth failing on."""
    assert excel_serial_to_iso("  46221  ") == "2026-07-18"
