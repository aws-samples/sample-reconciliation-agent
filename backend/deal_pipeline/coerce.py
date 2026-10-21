"""Pure helpers that turn deal-email phrasing into OMS field formats.

The parsing agent asks the model for OMS-formatted values, but models paraphrase: a percent field
comes back as ``S+200``, a millions field as ``$1.75bn``, a date as ``Aug. 13``. Rather than send
every such slip back to the model (another round trip, another chance to slip), the agent runs the
helper for the field's type and only escalates what still fails. Every helper returns None when it
cannot interpret the text, so the caller can tell "normalized" from "gave up".

All functions are side-effect free and take/return plain strings; the formats are those of
``docs/deal-pipeline-design.md`` section 5.
"""

import re
from datetime import date, datetime

_NUMBER = re.compile(r"\d+(?:\.\d+)?")

# Spread talk written without a unit is read as basis points when it is at least this large;
# no floor or coupon is ever quoted as "25%" in a launch email, and no spread as "0.25 bps".
_BARE_BPS_THRESHOLD = 25.0


def _numbers(text: str) -> list[float]:
    """All unsigned decimal numbers in ``text`` in order of appearance (commas are not separators)."""
    return [float(n) for n in _NUMBER.findall(text.replace(",", ""))]


def _pct(value: float) -> str:
    return f"{value:.3f}%"


# The unit of a number is decided by what sits right next to it, never by the whole string:
# "S+275-300 (0% floor)" quotes a spread in bps AND a floor in percent, and reading the "%" as
# the unit of every number would stage the spread as 275.000%.
_BENCHMARK_PREFIX = re.compile(r"\b(?:s|sofr|l|libor|e|euribor|t|sonia)\s*\+\s*$")
_BPS_SUFFIX = re.compile(r"^\s*bps?\b")
_PCT_SUFFIX = re.compile(r"^\s*(?:%|percent\b|pct\b)")
# Text between the two ends of one range ("275-300", "275 to 300"); both ends share a unit.
_RANGE_JOIN = re.compile(r"\s*(?:-|\u2013|\u2014|to)\s*")


def _tagged_number_groups(lowered: str) -> list[tuple[str | None, list[float]]]:
    """Split the numbers in ``lowered`` into range groups tagged ``"bps"``, ``"pct"`` or None.

    A number is basis points when a benchmark prefix (``S+``) precedes it or ``bps`` follows it,
    and percent when ``%``, ``percent`` or ``pct`` follows it. The two ends of a range take
    whichever tag either end carries (``400-425 bps``). Untagged groups are left to the caller.
    """
    groups: list[tuple[str | None, list[float]]] = []
    previous_end: int | None = None
    for m in _NUMBER.finditer(lowered):
        before, after = lowered[: m.start()], lowered[m.end() :]
        tag = None
        if _BENCHMARK_PREFIX.search(before) or _BPS_SUFFIX.match(after):
            tag = "bps"
        elif _PCT_SUFFIX.match(after):
            tag = "pct"
        value = float(m.group(0))
        joined = previous_end is not None and _RANGE_JOIN.fullmatch(
            lowered[previous_end : m.start()]
        )
        if groups and joined:
            previous_tag, values = groups[-1]
            groups[-1] = (previous_tag or tag, [*values, value])
        else:
            groups.append((tag, [value]))
        previous_end = m.end()
    return groups


def bps_or_spread_to_percent(text: str) -> tuple[str, str] | None:
    """Convert spread / coupon talk to a ``(low, high)`` pair of OMS percent strings.

    Understands basis-point spreads over a benchmark (``S+200``, ``SOFR+275-300``, ``200 bps``),
    percentages (``2%``, ``7.25%-7.50% area``) and bare numbers (basis points when >= 25,
    otherwise percent). A single value is returned as both ends of the pair. When the text
    quotes both a spread and a percent (``S+275, 0.50% floor``) only the spread is read: it is
    what a spread-talk field holds, and the floor belongs to a field of its own.

    :param text: the talk as written, e.g. ``"S+275-300"``.
    :returns: ``("2.750%", "3.000%")`` style pair, or None when no number is present.
    """
    if not text:
        return None
    groups = _tagged_number_groups(text.lower().replace(",", ""))
    if not groups:
        return None
    for tag in ("bps", "pct"):
        chosen = [values for group_tag, values in groups if group_tag == tag]
        if chosen:
            break
    else:
        tag, chosen = None, [values for _, values in groups]
    numbers = [n for values in chosen for n in values]
    low, high = numbers[0], numbers[1] if len(numbers) > 1 else numbers[0]
    if low > high:
        low, high = high, low
    is_bps = tag == "bps" if tag else low >= _BARE_BPS_THRESHOLD
    if is_bps:
        low, high = low / 100.0, high / 100.0
    return _pct(low), _pct(high)


_MONEY_UNIT = re.compile(
    r"(?P<num>\d[\d,]*(?:\.\d+)?)\s*(?P<unit>billion|bn|b|million|mm|mn|m|thousand|k)?\b",
    re.IGNORECASE,
)
_UNIT_TO_MM = {
    "billion": 1000.0,
    "bn": 1000.0,
    "b": 1000.0,
    "million": 1.0,
    "mm": 1.0,
    "mn": 1.0,
    "m": 1.0,
    "thousand": 0.001,
    "k": 0.001,
}


def money_to_mm(text: str) -> str | None:
    """Convert an amount written in an email to millions with three decimals.

    ``$500 million``, ``$2,157 million``, ``$700,000,000``, ``$1.75bn``, ``€200MM`` and ``600M``
    all normalize; currency symbols and codes are ignored (the OMS carries currency separately).
    A bare number with no unit is taken as already-in-millions unless it is at least one million,
    in which case it is read as whole currency units.

    :param text: the amount as written.
    :returns: e.g. ``"500.000"``, or None when no number is present.
    """
    if not text:
        return None
    m = _MONEY_UNIT.search(text)
    if not m:
        return None
    number = float(m.group("num").replace(",", ""))
    unit = (m.group("unit") or "").lower()
    if unit:
        millions = number * _UNIT_TO_MM[unit]
    elif number >= 1_000_000:
        millions = number / 1_000_000
    else:
        millions = number
    return f"{millions:.3f}"


def oid_to_prices(text: str) -> tuple[str, str] | None:
    """Convert OID / issue-price talk to a ``(low, high)`` pair of OMS price strings.

    ``99.5-99.75`` becomes ``("99.500", "99.750")``; a single price such as ``99.75`` is returned
    as both ends; ``par`` is 100.

    :param text: the price talk as written.
    :returns: the pair, or None when the text carries no price.
    """
    if not text:
        return None
    if re.search(r"\bpar\b", text, re.IGNORECASE) and not _NUMBER.search(text):
        return "100.000", "100.000"
    numbers = _numbers(text)
    if not numbers:
        return None
    low, high = numbers[0], numbers[1] if len(numbers) > 1 else numbers[0]
    if low > high:
        low, high = high, low
    return f"{low:.3f}", f"{high:.3f}"


_WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
}  # fmt: skip
_TENOR_YEARS = re.compile(r"(\d+(?:\.\d+)?)\s*-?\s*(?:yrs?|years?|y)\b", re.IGNORECASE)
_TENOR_MONTHS = re.compile(r"(\d+)\s*-?\s*(?:mos?|months?)\b", re.IGNORECASE)
_BARE_TENOR = re.compile(r"\s*(\d+(?:\.\d+)?)\s*")
# A bare number is only a tenor when it could be one. "2033" is a maturity year and "0" is no
# term at all; both return None so the model is asked to derive the tenor instead of the OMS
# receiving "2033 yr", which its format check would accept.
_MAX_TENOR_YEARS = 50.0


def _trim_number(value: float) -> str:
    """``7.0`` -> ``"7"``, ``4.50`` -> ``"4.5"``."""
    return f"{value:g}" if value != int(value) else str(int(value))


def tenor_to_terms(text: str) -> str | None:
    """Normalize a tenor to the OMS ``N yr`` form (``7 Years`` -> ``7 yr``, ``eight-year`` -> ``8 yr``).

    Month tenors are converted (``18 months`` -> ``1.5 yr``). Only the first tenor in the text
    counts, so ``5 years (with a 91-day springing maturity ...)`` is ``5 yr``. A bare number is
    read as years when it is a plausible tenor (more than 0, at most 50); a bare maturity year
    such as ``2033`` is not a tenor and returns None.

    :param text: the tenor as written.
    :returns: ``"N yr"``, or None when no tenor can be read.
    """
    if not text:
        return None
    lowered = text.lower()
    for word, n in _WORD_NUMBERS.items():
        lowered = re.sub(rf"\b{word}\b", str(n), lowered)
    years = _TENOR_YEARS.search(lowered)
    if years:
        return f"{_trim_number(float(years.group(1)))} yr"
    months = _TENOR_MONTHS.search(lowered)
    if months:
        return f"{_trim_number(round(int(months.group(1)) / 12.0, 2))} yr"
    bare = _BARE_TENOR.fullmatch(lowered)
    if bare and 0 < float(bare.group(1)) <= _MAX_TENOR_YEARS:
        return f"{_trim_number(float(bare.group(1)))} yr"
    return None


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}  # fmt: skip
# The captured group is always the three-letter prefix; "[a-z]*" swallows "uary", "t." and so on.
_MONTH_NAME = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
_DAY = r"(\d{1,2})(?:st|nd|rd|th)?"
_ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?\b")
_MONTH_DAY = re.compile(rf"\b{_MONTH_NAME}\s+{_DAY}\b(?:,?\s*(\d{{4}}))?", re.IGNORECASE)
_DAY_MONTH = re.compile(rf"\b{_DAY}\s+{_MONTH_NAME}(?:,?\s*(\d{{4}}))?", re.IGNORECASE)
_DAY_ONLY = re.compile(r"\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b", re.IGNORECASE)

# "Aug. 13" in an email sent in December is next August, not the one eight months back, and
# "Dec. 28" in an email sent on January 3rd is the December just gone, not the one a year out.
# A month/day more than this many days from the reference in either direction is assumed to
# belong to the adjacent year.
_YEAR_TOLERANCE_DAYS = 300


def parse_iso(text) -> datetime | None:
    """Parse an ISO-8601 date/time leniently: a ``Z`` suffix is accepted, garbage returns None.

    The BFF is meant to store ``sent`` and ``received_at`` as ISO-8601, but its check lets a
    ``8/5/2026`` or ``Aug 5, 2026 9:58 AM`` through, and a header the pipeline cannot read must
    degrade to a fallback rather than fail the whole parse.

    :param text: the timestamp text; None, "" and non-strings are unreadable.
    :returns: the (aware when an offset was written) datetime, or None.
    """
    if not text or not isinstance(text, str):
        return None
    try:
        return datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _reference_date(reference_iso: str | None) -> date:
    """The reference's calendar date as written (no zone conversion); today when unreadable."""
    parsed = parse_iso(reference_iso)
    return parsed.date() if parsed else datetime.now().date()


def _infer_year(month: int, day: int, reference: date) -> int:
    """Pick the year for a month/day that omitted one, relative to the reference (email) date."""
    try:
        candidate = date(reference.year, month, day)
    except ValueError:
        return reference.year
    if (reference - candidate).days > _YEAR_TOLERANCE_DAYS:
        return reference.year + 1
    if (candidate - reference).days > _YEAR_TOLERANCE_DAYS:
        return reference.year - 1
    return reference.year


def _fmt_date(year: int, month: int, day: int) -> str | None:
    try:
        date(year, month, day)
    except ValueError:
        return None
    return f"{month}/{day}/{year}"


def to_date(text: str, reference_iso: str | None = None) -> str | None:
    """Normalize a date mention to ``M/D/YYYY``.

    Handles ISO timestamps, ``4/18/2031``, ``8/13`` and ``Aug. 13`` (year taken from the
    reference email date; if that would put the date more than 300 days in the past the next
    year is assumed, more than 300 days in the future the previous one), ``Thursday, May 7th,
    2026``, ``13 August 2026`` and prose such as ``noon ET Thursday, Aug. 13``. A day alone
    (``Tuesday the 28th``) is placed in the reference month, or the following month when that
    day has already passed.

    :param text: the date mention as written.
    :param reference_iso: ISO-8601 date/time of the email the mention comes from; today when
        None or unreadable.
    :returns: ``"8/13/2026"`` style text, or None when no date can be read.
    """
    if not text:
        return None
    reference = _reference_date(reference_iso)
    iso = _ISO_DATE.search(text)
    if iso:
        return _fmt_date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
    numeric = _NUMERIC_DATE.search(text)
    if numeric:
        month, day = int(numeric.group(1)), int(numeric.group(2))
        year_text = numeric.group(3)
        if year_text is None:
            year = _infer_year(month, day, reference)
        elif len(year_text) == 2:
            year = 2000 + int(year_text)
        else:
            year = int(year_text)
        return _fmt_date(year, month, day)
    for pattern, month_group, day_group in ((_MONTH_DAY, 1, 2), (_DAY_MONTH, 2, 1)):
        m = pattern.search(text)
        if m:
            month = _MONTHS[m.group(month_group).lower()[:3]]
            day = int(m.group(day_group))
            year = int(m.group(3)) if m.group(3) else _infer_year(month, day, reference)
            return _fmt_date(year, month, day)
    day_only = _DAY_ONLY.search(text)
    if day_only:
        day = int(day_only.group(1))
        month, year = reference.month, reference.year
        if day < reference.day:
            month, year = (1, year + 1) if month == 12 else (month + 1, year)
        return _fmt_date(year, month, day)
    return None


_TIME = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$|[^\w:])", re.IGNORECASE)


def to_time(text: str) -> str | None:
    """Normalize a time mention to the OMS ``h[:mm]AM|PM`` form.

    ``noon`` -> ``12PM``, ``12:00 PM ET`` -> ``12PM``, ``1:15 PM EST`` -> ``1:15PM``,
    ``4:00PM`` -> ``4PM``, ``17:00`` -> ``5PM``. Time zone suffixes are dropped: the OMS field is
    desk-local by convention. Minutes are omitted when zero.

    :param text: the time mention as written.
    :returns: the normalized time, or None when none can be read.
    """
    if not text:
        return None
    lowered = text.strip().lower()
    if re.search(r"\bnoon\b|\bmidday\b", lowered):
        return "12PM"
    if re.search(r"\bmidnight\b", lowered):
        return "12AM"
    for m in _TIME.finditer(lowered):
        hour, minute, meridiem = int(m.group(1)), int(m.group(2) or 0), m.group(3)
        if minute > 59:
            continue
        if meridiem:
            if not 1 <= hour <= 12:
                continue
            suffix = "AM" if meridiem.startswith("a") else "PM"
        elif m.group(2) is not None and 0 <= hour <= 23:
            # 24-hour clock is only unambiguous when minutes are written ("17:00", "09:30").
            suffix = "PM" if hour >= 12 else "AM"
            hour = hour % 12 or 12
        else:
            continue
        return f"{hour}:{minute:02d}{suffix}" if minute else f"{hour}{suffix}"
    return None


_YES = {"yes", "y", "true", "t", "1"}
_NO = {"no", "n", "false", "f", "0"}


def yes_no(value) -> str | None:
    """Normalize a boolean-ish value to ``Yes`` / ``No``.

    :param value: a bool, or text such as ``"yes"``, ``"True"``, ``"N"``. None and "" map to
        "" (blank), which the OMS accepts for optional booleans.
    :returns: ``"Yes"``, ``"No"``, ``""``, or None when the text is not a recognizable answer.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    text = str(value).strip().lower()
    if text == "":
        return ""
    if text in _YES:
        return "Yes"
    if text in _NO:
        return "No"
    return None


_SP_IG = {"AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-"}
_SP_HY = {"BB+", "BB", "BB-", "B+", "B", "B-", "CCC+", "CCC", "CCC-", "CC", "C", "D", "SD"}
_MOODYS_IG = {"AAA", "AA1", "AA2", "AA3", "A1", "A2", "A3", "BAA1", "BAA2", "BAA3"}
_MOODYS_HY = {"BA1", "BA2", "BA3", "B1", "B2", "B3", "CAA1", "CAA2", "CAA3", "CA", "C"}
_RATING_TOKEN = re.compile(r"[A-Za-z]{1,3}\d?[+-]?")


def _is_ig(rating: str | None, ig_set: set[str], hy_set: set[str]) -> bool | None:
    """True/False for a rating in the agency's scale; None for blank, NR/TBA or unknown text."""
    if not rating:
        return None
    # Scan every token: "CFR B3 / B (Stable)" carries the rating after a label.
    for m in _RATING_TOKEN.finditer(rating):
        token = m.group(0).upper()
        if token in ig_set:
            return True
        if token in hy_set:
            return False
    return None


def ig_from_rating(sp: str | None, moodys: str | None) -> str | None:
    """Derive the OMS ``Is Investment Grade?`` flag from issue ratings.

    S&P leads (the OMS rule keys on it): BBB- or better is ``Yes``, BB+ or worse is ``No``. Only
    when S&P is absent or unrated is Moody's consulted (Baa3 or better is ``Yes``). Available for
    callers that want it; the initial parsing skill deliberately does not apply it, so the
    learning loop has the ``IG_FLAG`` rule to learn.

    :param sp: S&P issue rating text, e.g. ``"BBB-"`` or ``"BB (Stable)"``.
    :param moodys: Moody's issue rating text, e.g. ``"Ba1"``.
    :returns: ``"Yes"``, ``"No"``, or None when neither rating is readable.
    """
    verdict = _is_ig(sp, _SP_IG, _SP_HY)
    if verdict is None:
        verdict = _is_ig(moodys, _MOODYS_IG, _MOODYS_HY)
    if verdict is None:
        return None
    return "Yes" if verdict else "No"
