"""Builds a snapshot of IDP's OWN tracking/progress metadata for a document.

This is deliberately separate from ``mapper.py``. That module maps a completion event to a
Notice -- the EXTRACTED CONTENT of a document. This module captures the pipeline's metadata ABOUT
the run itself (status, timings, config version, page count, per-section alert flags), which the
Documents tab used to read live from IDP's AppSync API and will instead read off the notice row.

There is exactly ONE function here on purpose. It will be called from two branches in the hook
handler (the SUCCEEDED completion path, and a FAILED path added in a later task) and those two call
sites must never be able to disagree on what a given field means or how it falls back -- two
near-identical implementations drift the moment one of them gets a bug fix the other does not.

**Two accepted shapes.** ``backend/idp_hook/mapper.py``'s module docstring documents this in
depth for the content fields; it applies just as much here. The record IDP hands the hook AFTER
``IdpOutputReader.resolve_document`` runs is **snake_case** (verified against a live run) --
``status``, ``workflow_status``, ``config_version``, ``queued_time``, ``initial_event_time``,
``completion_time``, ``num_pages``, and a ``sections`` list of
``{section_id, confidence_threshold_alerts, ...}``. Some older IDP deployments still emit an
uncompressed **PascalCase** record, and six of this module's PascalCase key candidates
(``ObjectStatus``, ``ConfigVersion``, ``EvaluationStatus``, ``QueuedTime``, ``InitialEventTime``,
``CompletionTime`` -- plus ``WorkflowStatus``/``PageCount``, already established by
``mapper.py``) are not a guess: they are the exact field names the AppSync API this branch is
retiring hard-codes in its GraphQL selection set, which is the strongest evidence available that
IDP's own tracking record really does carry them under those spellings. See
``chatbot-app/frontend/src/app/api/recon/idp-documents/route.ts`` (``DOCUMENT_FIELDS``, ~L30-46),
``chatbot-app/frontend/src/app/api/recon/idp-documents/[objectKey]/route.ts`` (the detail query,
~L18-33), and the ``IdpDocument`` interface in ``chatbot-app/frontend/src/lib/reconApi.ts``
(~L1314-1340). Both shapes must keep working.

**Absence is a fact, not a default.** An IDP run genuinely may not have reached a given stage yet
(e.g. ``completion_time`` is present as a key but ``None`` while the record is still
``EVALUATING`` at hook time -- verified live). Downstream code distinguishes "the pipeline has not
reported this yet" from "it reported an empty value", so a field this function cannot resolve from
either the record or the event detail must be OMITTED from the returned dict, never written as
``""`` or a filled-in ``None``. This mirrors the ``exclude_none`` convention the Notice model
relies on elsewhere in this codebase.
"""

from datetime import datetime, timezone
from typing import Any, Optional

# Aliased to `_decimalize` so every call site below reads exactly as it did when this module had
# its own private copy -- this function is OWNED by mapper.py (public there for the same reason
# `split_s3_uri` is: cross-module reuse), not by this file.
from backend.idp_hook.mapper import decimalize as _decimalize


def _first(document: dict, *keys: str) -> Any:
    """Return the first non-``None`` value found under any of ``keys``.

    Tries each candidate key spelling in order so one call site can tolerate both the live
    snake_case tracking record and the older PascalCase shape. A key that IS present but maps to
    ``None`` is treated exactly like an absent key -- IDP reports ``completion_time: None`` at hook
    time on every live run seen so far, and that must fall through to the next candidate (typically
    a ``detail`` fallback in the caller), not stop here and report "found: None".

    :param document: the resolved IDP tracking record.
    :param keys: candidate key spellings, tried in order.
    :returns: the first non-``None`` value found, or ``None`` if every key is absent or ``None``.
    """
    for key in keys:
        value = document.get(key)
        if value is not None:
            return value
    return None


def _epoch_millis_to_iso(value: Optional[int]) -> Optional[str]:
    """Convert an EventBridge epoch-millisecond timestamp to an ISO-8601 UTC string.

    ``detail["startDate"]``/``detail["stopDate"]`` are epoch MILLISECONDS (e.g.
    ``1788967194871``), not seconds and not ISO strings -- confirmed against a live event. Every
    other timestamp this module reads (``queued_time``, ``initial_event_time`` when the record
    supplies it) already arrives as an ISO string and is passed through verbatim -- never
    reparsed or reformatted, so IDP's own ``Z``-suffixed, 0- or microsecond-precision strings
    reach the snapshot exactly as IDP wrote them.

    Because of that "pass through verbatim" rule, ``initial_event_time``/``completion_time`` can
    legitimately carry DIFFERENT ISO-8601 variants across records for the very same field: a
    record that supplies its own value keeps whatever IDP wrote (e.g. a bare ``Z`` suffix,
    3-digit milliseconds), while a record that omits it gets THIS function's ``+00:00``-offset,
    6-digit-microsecond ``isoformat()`` output instead. This is deliberate, not an inconsistency
    to "fix" by normalising one to match the other: a value IDP itself supplied must never be
    rewritten, and a value this module fabricates from ``detail`` cannot silently pretend to be
    one IDP wrote.

    :param value: epoch milliseconds, or ``None``.
    :returns: an ISO-8601 string in UTC, or ``None`` when ``value`` is ``None``.
    """
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def _section_id(section: dict) -> str:
    """Read a section's id, tolerating both accepted shapes, and coerce it to ``str``.

    Cast to string because ``idp_sections[].section_id`` on the Notice model (see
    ``backend/idp_hook/mapper.py``) is already a string, and ``sections_meta`` has to join against
    it by that key -- a PascalCase record's numeric-looking ``Id`` would otherwise compare unequal
    to the string it needs to match.

    :param section: one entry from the record's ``sections``/``Sections`` list.
    :returns: the section id as a string (``""`` if the section carries neither key).
    """
    raw = section.get("section_id")
    if raw is None:
        raw = section.get("Id")
    return str(raw) if raw is not None else ""


def _sections_meta(document: dict) -> list[dict]:
    """Build the per-section alert summary the Documents tab joins against notice sections.

    :param document: the resolved IDP tracking record.
    :returns: one ``{section_id, confidence_threshold_alerts}`` entry per section; a section that
        carries no ``confidence_threshold_alerts`` key at all omits it rather than defaulting to an
        empty list, per this module's absence-is-a-fact rule.
    """
    sections = document.get("sections") or document.get("Sections") or []
    meta: list[dict] = []
    for section in sections:
        entry: dict[str, Any] = {"section_id": _section_id(section)}
        if "confidence_threshold_alerts" in section:
            entry["confidence_threshold_alerts"] = _decimalize(
                section["confidence_threshold_alerts"]
            )
        meta.append(entry)
    return meta


def build_tracking_snapshot(*, document: dict, detail: dict) -> dict:
    """Extract IDP's tracking/progress metadata for one document into a plain snapshot dict.

    Pure function: no I/O, no AWS calls. Called from both the SUCCEEDED and FAILED hook branches
    (the latter added in a later task) so the two paths can never disagree on a field's meaning or
    its fallback order.

    :param document: the RESOLVED IDP tracking record (``IdpOutputReader.resolve_document``'s
        output) -- snake_case in every live run, PascalCase tolerated for older deployments.
    :param detail: the raw EventBridge ``event["detail"]`` for this Step Functions execution, used
        only as a fallback when the record itself omits a field.
    :returns: a dict with keys ``object_status``, ``workflow_status``, ``config_version``,
        ``evaluation_status``, ``queued_time``, ``initial_event_time``, ``completion_time``,
        ``page_count``, ``evaluation_report_uri``, ``summary_report_uri``, ``snapshot_at`` and
        ``sections_meta``. Every field except ``snapshot_at`` and ``sections_meta`` is OMITTED
        (never ``""``/``None``) when neither the record nor ``detail`` supplies it.
    """
    snapshot: dict[str, Any] = {}

    object_status = _first(document, "status", "ObjectStatus")
    if object_status is not None:
        snapshot["object_status"] = object_status

    # workflow_status falls back to detail["status"] -- the record's own field is absent at hook
    # time on the live shape (status there is EVALUATING, describing the OBJECT, not the workflow).
    workflow_status = _first(document, "workflow_status", "WorkflowStatus")
    if workflow_status is None:
        workflow_status = detail.get("status")
    if workflow_status is not None:
        snapshot["workflow_status"] = workflow_status

    config_version = _first(document, "config_version", "ConfigVersion")
    if config_version is not None:
        snapshot["config_version"] = config_version

    evaluation_status = _first(document, "evaluation_status", "EvaluationStatus")
    if evaluation_status is not None:
        snapshot["evaluation_status"] = evaluation_status

    # queued_time has no `detail` fallback: EventBridge carries no equivalent timestamp for it, so
    # an omitted record field stays omitted rather than being guessed at.
    queued_time = _first(document, "queued_time", "QueuedTime")
    if queued_time is not None:
        snapshot["queued_time"] = queued_time

    initial_event_time = _first(document, "initial_event_time", "InitialEventTime")
    if initial_event_time is None:
        initial_event_time = _epoch_millis_to_iso(detail.get("startDate"))
    if initial_event_time is not None:
        snapshot["initial_event_time"] = initial_event_time

    # THE live case: the record carries the key but the value is None (evaluation is not stamped
    # yet), so `_first` treats it as absent and this falls through to detail["stopDate"].
    completion_time = _first(document, "completion_time", "CompletionTime")
    if completion_time is None:
        completion_time = _epoch_millis_to_iso(detail.get("stopDate"))
    if completion_time is not None:
        snapshot["completion_time"] = completion_time

    page_count = _first(document, "num_pages", "PageCount")
    if page_count is not None:
        # int(), never Decimal: PageCount/num_pages is always a whole number, and boto3 accepts
        # Python ints for DynamoDB natively -- only fractional numerics need Decimal here.
        snapshot["page_count"] = int(page_count)

    # UNCONFIRMED GUESS, unlike the six PascalCase names above: "EvaluationReportUri" and
    # "SummaryReportUri" are NOT evidenced anywhere -- not in the retiring AppSync schema (the
    # DOCUMENT_FIELDS/IdpDocument citations above list no report-URI field at all), not in
    # idp_output.py, not in mapper.py, nowhere in this repo. `evaluation_report_uri` /
    # `summary_report_uri` are only ever seen on the live snake_case record, so a PascalCase
    # tracking record may never have carried a report URI under ANY name -- this branch could be
    # permanently unreachable. Kept because an unmatched key correctly falls through to "absent"
    # (see `_first`), so the guess costs nothing if wrong; it must not be read as verified the way
    # the six names above are.
    evaluation_report_uri = _first(document, "evaluation_report_uri", "EvaluationReportUri")
    if evaluation_report_uri is not None:
        snapshot["evaluation_report_uri"] = evaluation_report_uri

    summary_report_uri = _first(document, "summary_report_uri", "SummaryReportUri")
    if summary_report_uri is not None:
        snapshot["summary_report_uri"] = summary_report_uri

    # Always present: this is the time THIS snapshot was built, not a value read off either input.
    snapshot["snapshot_at"] = datetime.now(timezone.utc).isoformat()
    snapshot["sections_meta"] = _sections_meta(document)

    return snapshot
