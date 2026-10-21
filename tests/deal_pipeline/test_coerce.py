"""Every coercion helper, including the None ("could not read") outcomes the agent relies on."""

import re
from datetime import UTC, datetime, timedelta, timezone

import pytest

from backend.deal_pipeline import coerce

REFERENCE = "2026-08-10T09:42:00-04:00"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("S+200", ("2.000%", "2.000%")),
        ("200 bps", ("2.000%", "2.000%")),
        ("2%", ("2.000%", "2.000%")),
        ("S+275-300", ("2.750%", "3.000%")),
        ("S+400-425 bps", ("4.000%", "4.250%")),
        ("SOFR+225", ("2.250%", "2.250%")),
        ("7.25%-7.50% area", ("7.250%", "7.500%")),
        ("0.00%", ("0.000%", "0.000%")),
        ("0% floor", ("0.000%", "0.000%")),
        ("275", ("2.750%", "2.750%")),
        ("7.25", ("7.250%", "7.250%")),
        ("300-275", ("2.750%", "3.000%")),
        ("2.000%", ("2.000%", "2.000%")),
        # Spread and floor quoted in one phrase: the unit is decided per number, and only the
        # spread is read (the floor belongs to its own field).
        ("S+275-300 (0% floor)", ("2.750%", "3.000%")),
        ("S+275, 0.50% floor", ("2.750%", "2.750%")),
        ("S+200, with a 0% floor", ("2.000%", "2.000%")),
        ("S+175 bps, 0.00% floor", ("1.750%", "1.750%")),
        ("0.50% floor, 275 bps", ("2.750%", "2.750%")),
        ("400-425 bps", ("4.000%", "4.250%")),
        ("7.25-7.50%", ("7.250%", "7.500%")),
        ("TBD", None),
        ("", None),
    ],
)
def test_bps_or_spread_to_percent(text, expected):
    assert coerce.bps_or_spread_to_percent(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("$500 million", "500.000"),
        ("$2,157 million", "2157.000"),
        ("$700,000,000", "700.000"),
        ("$1.75bn", "1750.000"),
        ("$1.2 billion", "1200.000"),
        ("$200MM", "200.000"),
        ("600M", "600.000"),
        ("EUR 400mn", "400.000"),
        ("$750k", "0.750"),
        ("500", "500.000"),
        ("1750.000", "1750.000"),
        ("n/a", None),
        ("", None),
    ],
)
def test_money_to_mm(text, expected):
    assert coerce.money_to_mm(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("99.5-99.75", ("99.500", "99.750")),
        ("99.75", ("99.750", "99.750")),
        ("99.00-99.50", ("99.000", "99.500")),
        ("98.50 - 99.00", ("98.500", "99.000")),
        ("99.75-99.5", ("99.500", "99.750")),
        ("par", ("100.000", "100.000")),
        ("TBD", None),
    ],
)
def test_oid_to_prices(text, expected):
    assert coerce.oid_to_prices(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("7 Years", "7 yr"),
        ("7 Year", "7 yr"),
        ("4.5 yr", "4.5 yr"),
        ("five years", "5 yr"),
        ("eight-year", "8 yr"),
        ("7yr", "7 yr"),
        ("5 years (with a 91-day springing maturity)", "5 yr"),
        ("18 months", "1.5 yr"),
        ("7", "7 yr"),
        ("50", "50 yr"),
        # A bare maturity year is not a tenor; None sends the field back to the model.
        ("2033", None),
        ("2028", None),
        ("Maturity: 2033", None),
        ("51", None),
        ("0", None),
        ("January 2031", None),
        ("", None),
    ],
)
def test_tenor_to_terms(text, expected):
    assert coerce.tenor_to_terms(text) == expected


@pytest.mark.parametrize(
    ("text", "reference", "expected"),
    [
        ("Aug. 13", REFERENCE, "8/13/2026"),
        ("Thursday, May 7th, 2026", REFERENCE, "5/7/2026"),
        ("8/13", REFERENCE, "8/13/2026"),
        ("4/18/2031", REFERENCE, "4/18/2031"),
        ("6/5/26", REFERENCE, "6/5/2026"),
        ("noon ET Thursday, Aug. 13", REFERENCE, "8/13/2026"),
        ("Wednesday, March 18th at 12PM ET", "2026-03-11T08:15:00-04:00", "3/18/2026"),
        ("13 Aug. 2026", REFERENCE, "8/13/2026"),
        ("2026-08-13T09:42:00-04:00", REFERENCE, "8/13/2026"),
        ("2026-08-13", None, "8/13/2026"),
        # Year inference: a month/day well before the email date belongs to the next year...
        ("Jan 5", "2026-12-20T10:00:00Z", "1/5/2027"),
        ("Jan 5", "2026-02-20", "1/5/2026"),
        # ...and one well after it belongs to the previous year: a Jan 3 notice saying the deal
        # launched Dec. 28 means the December just gone, not one 359 days out.
        ("Dec. 28", "2027-01-03T10:00:00Z", "12/28/2026"),
        ("Launched Dec. 28", "2027-01-03T10:00:00Z", "12/28/2026"),
        ("12/28", "2027-01-03", "12/28/2026"),
        ("Dec. 28", "2027-03-15", "12/28/2027"),
        # Day only: reference month, or the next month when that day has already passed.
        ("Tuesday the 28th", "2026-07-17T11:20:00-04:00", "7/28/2026"),
        ("the 3rd", "2026-07-17", "8/3/2026"),
        ("the 3rd", "2026-12-17", "1/3/2027"),
        ("January 2031", REFERENCE, None),
        ("2/30/2026", REFERENCE, None),
        ("due soon", REFERENCE, None),
        ("", REFERENCE, None),
    ],
)
def test_to_date(text, reference, expected):
    assert coerce.to_date(text, reference) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("noon", "12PM"),
        ("12PM", "12PM"),
        ("12:00 PM ET", "12PM"),
        ("1:15 PM EST", "1:15PM"),
        ("4:00PM", "4PM"),
        ("10:30 AM ET", "10:30AM"),
        ("1pm", "1PM"),
        ("12:30pm ET", "12:30PM"),
        ("17:00", "5PM"),
        ("09:30", "9:30AM"),
        ("5:00 p.m.", "5PM"),
        ("midnight", "12AM"),
        ("Aug. 13", None),
        ("13PM", None),
        ("COB", None),
        ("", None),
    ],
)
def test_to_time(text, expected):
    assert coerce.to_time(text) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (True, "Yes"),
        (False, "No"),
        ("yes", "Yes"),
        ("Y", "Yes"),
        ("true", "Yes"),
        ("no", "No"),
        ("FALSE", "No"),
        ("", ""),
        (None, ""),
        ("maybe", None),
    ],
)
def test_yes_no(value, expected):
    assert coerce.yes_no(value) == expected


@pytest.mark.parametrize(
    ("sp", "moodys", "expected"),
    [
        ("BBB-", "Ba1", "Yes"),  # S&P leads: a split rating is IG when S&P says so
        ("BB", "Baa3", "No"),
        ("BB+", None, "No"),
        ("A-", None, "Yes"),
        ("TBA", "Baa3", "Yes"),  # Moody's only when S&P is unrated
        ("NR", "Ba2", "No"),
        (None, "Aa2", "Yes"),
        ("CFR B3 / B (Stable)", None, "No"),
        (None, None, None),
        ("TBA", "", None),
    ],
)
def test_ig_from_rating(sp, moodys, expected):
    assert coerce.ig_from_rating(sp, moodys) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "2026-08-05T09:58:00-04:00",
            datetime(2026, 8, 5, 9, 58, tzinfo=timezone(-timedelta(hours=4))),
        ),
        ("2026-08-06T00:30:00.000Z", datetime(2026, 8, 6, 0, 30, tzinfo=UTC)),
        ("2026-08-05T09:58:00", datetime(2026, 8, 5, 9, 58)),
        ("2026-08-05", datetime(2026, 8, 5)),
        # What the BFF's Date.parse check lets through but ISO-8601 is not.
        ("8/5/2026", None),
        ("Aug 5, 2026 9:58 AM", None),
        ("Tue, 05 Aug 2026 09:58:00 -0400", None),
        ("", None),
        (None, None),
        (20260805, None),
    ],
)
def test_parse_iso(text, expected):
    assert coerce.parse_iso(text) == expected


@pytest.mark.parametrize("reference", ["8/5/2026", "Aug 5, 2026 9:58 AM", "not a date"])
def test_to_date_with_an_unreadable_reference_falls_back_instead_of_raising(reference):
    # The exact year depends on today's date, so only the shape and the month/day are pinned.
    assert re.fullmatch(r"8/13/\d{4}", coerce.to_date("Aug. 13", reference))
    assert coerce.to_date("4/18/2031", reference) == "4/18/2031"
