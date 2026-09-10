"""Pure derivations over a notice's own fields. No I/O, no AWS, no model imports.

Two functions, each of which exists because the alternative is a judgement the model would otherwise
make in a prompt:

* :func:`is_source_finalized` — whether the SOURCE considers the record final, which is one of the
  evidence-status conditions a candidate is judged on;
* :func:`excel_serial_to_iso` — the Excel-serial date conversion, written once and tested, so no caller
  ever open-codes the 1900 leap-year artefact.

They live apart from ``notices.py`` on purpose: that module is the store, and a store that also decides
things is a module with two reasons to change.

⚠️ Do NOT add a derivation over the amount fields here. Classifying which amount a notice supports
means reading names like ``global_amount`` and ``fee_amount`` off the extraction by literal key, and
those names belong to the document pipeline's configuration — a rename there makes the classification
silently wrong rather than loud. The figures are carried verbatim in ``Notice.idp_sections[].fields``,
and a reader that needs the distinction takes it from there, where the names are the extractor's own.

The provenance constants below are fine by that rule: they are decided by whichever component writes
the row, never extracted from a document.
"""

from datetime import date, timedelta

# The source system whose finalisation status means anything. Everything on the document path is
# "OTHER", which has no notion of being finalised by the source.
SOURCE_SYSTEM_STRUCTURED_FEED = "STRUCTURED_FEED"
SOURCE_SYSTEM_OTHER = "OTHER"

# How a notice's fields were produced. `USER_ENTERED` is declared but unused: no path in this platform
# lets a human type a notice, and the constant exists so the vocabulary is complete in one place rather
# than half-defined across two.
PARSE_METHOD_IDP = "IDP"
PARSE_METHOD_STRUCTURED_FEED = "STRUCTURED_FEED"
PARSE_METHOD_USER_ENTERED = "USER_ENTERED"

# The two feed statuses observed in the source extracts. `Reviewed` is the only one that means final.
SOURCE_STATUS_NEW = "New"
SOURCE_STATUS_REVIEWED = "Reviewed"
_KNOWN_SOURCE_STATUSES = frozenset({SOURCE_STATUS_NEW, SOURCE_STATUS_REVIEWED})

# Excel's 1900 date system, and the artefact that makes it not simply "epoch plus n days".
#
# Excel treats 1900 as a leap year, which it was not: serial 60 is the date 1900-02-29, which never
# existed. So serials on either side of that phantom day need different epochs — 1899-12-31 below it,
# 1899-12-30 above — and serial 60 itself has no valid date to convert to.
_EPOCH_BEFORE_PHANTOM = date(1899, 12, 31)
_EPOCH_AFTER_PHANTOM = date(1899, 12, 30)
_PHANTOM_SERIAL = 60

# Plausibility bounds (design DT7). Below 1 is not a date; the upper bound is far past any business
# date this platform will see, and its point is to reject a value that is really an amount or an id.
_MIN_SERIAL = 1
_MAX_SERIAL = 100000


def is_source_finalized(*, source_system: str | None, source_status_raw: str | None) -> bool:
    """Report whether the SOURCE system considers this record final.

    Finalisation is a property of the source, not of this platform, and only the structured
    notice feed has one. A notice parsed from a document therefore returns False — not because
    anything is wrong with it, but because "the source finalised it" is not a claim that can be
    made about it at all.

    A feed record with no status, or one this platform does not recognise, RAISES rather than
    returning False. The two are different findings: "the source says this is not final" is
    evidence, while "the source said something we cannot interpret" is a contract break, and
    treating the second as the first would let an unreadable status read as a considered negative.

    :param source_system: the notice's ``source_system`` (``STRUCTURED_FEED`` / ``OTHER``), or None.
    :param source_status_raw: the source's verbatim status, or None.
    :returns: True only for a feed record the source marked ``Reviewed``.
    :raises ValueError: when the record claims to come from the feed but its status is absent or
        unrecognised.
    """
    if source_system != SOURCE_SYSTEM_STRUCTURED_FEED:
        return False
    if source_status_raw is None or source_status_raw == "":
        raise ValueError(
            f"source_system={source_system!r} carries no source_status_raw; a feed record without "
            "a status cannot be judged final or not-final"
        )
    if source_status_raw not in _KNOWN_SOURCE_STATUSES:
        raise ValueError(
            f"unrecognised source_status_raw {source_status_raw!r}; known values are "
            f"{sorted(_KNOWN_SOURCE_STATUSES)}. An unknown status is not the same as 'not finalised'"
        )
    return source_status_raw == SOURCE_STATUS_REVIEWED


def excel_serial_to_iso(serial: str) -> str:
    """Convert an Excel 1900-system serial date to an ISO-8601 calendar date.

    ⚠️ The CUJ document's worked example (``46230`` ⇒ ``2026-07-18``) is arithmetically wrong under
    every epoch, and this function does NOT reproduce it. 46230 is 2026-07-27; the serial for 2026-07-18 is
    46221. Both are asserted in the tests so nobody "corrects" this converter to match the document.

    :param serial: the serial as a string, e.g. ``"46221"``. Surrounding whitespace is tolerated.
    :returns: the date as ``YYYY-MM-DD``.
    :raises ValueError: when the value is not an integer, falls outside the plausible range, or is the
        phantom 1900-02-29 (serial 60), which has no real date to convert to. Every one of these returns
        an error rather than a best guess: a wrong date silently shifts a notice out of its match window.
    """
    text = serial.strip()
    try:
        value = int(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"excel serial is not an integer: {serial!r}") from exc

    if not _MIN_SERIAL <= value <= _MAX_SERIAL:
        raise ValueError(
            f"excel serial {value} is outside the plausible range "
            f"[{_MIN_SERIAL}, {_MAX_SERIAL}] — this is more likely an amount or an identifier"
        )
    if value == _PHANTOM_SERIAL:
        raise ValueError(
            "excel serial 60 is Excel's phantom 1900-02-29, a date that never existed; it has no "
            "valid conversion and must be corrected at the source"
        )

    epoch = _EPOCH_BEFORE_PHANTOM if value < _PHANTOM_SERIAL else _EPOCH_AFTER_PHANTOM
    return (epoch + timedelta(days=value)).isoformat()
