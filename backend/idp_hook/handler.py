"""IDP post-processing hook. IDP invokes this on every TERMINAL Step-Function status --
SUCCEEDED, FAILED, TIMED_OUT, ABORTED -- with the completion event; we map a SUCCEEDED document to
a Notice — EVIDENCE on the actual side of the reconciliation — and store it in recon-notices.
Any other terminal outcome, or a SUCCEEDED execution recon cannot map to a notice, still gets a
TRACKING-ONLY row (see NoticeStore.put_document_record) so the document is never silently invisible
to the Documents tab: before this, a FAILED/TIMED_OUT/ABORTED document, or one with no extractable
notice_date, left no trace anywhere recon could show an analyst.

This hook deliberately does NOT create a reconciliation case. An extracted document is not a
break; it is one input the deterministic matcher and the agent read when a break already exists
-- extraction produces evidence, not a case. recon-notices has no DynamoDB stream, so there is no
path from here to
cases.open, and that absence is the control — not a flag anyone can flip.

IDP coupling: the inbound invocation (trigger) plus a single READ-ONLY read of IDP's output
bucket at ingest to embed the extracted field values + page-image locations into the notice
(user-approved — the detail screen renders these directly, no on-demand IDP call). The recon
runtime/agent still never reads IDP storage.
"""

import json
import logging
import os

from backend.idp_hook.idp_output import IdpOutputReader
from backend.idp_hook.mapper import idp_event_to_notice
from backend.idp_hook.tracking import build_tracking_snapshot
from backend.recon_core.notice_derive import PARSE_METHOD_IDP
from backend.recon_core.notice_index import NoticeSearchIndex, flatten_sections
from backend.recon_core.notices import NoticeStore

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Terminal outcomes other than SUCCEEDED. The EventBridge rule (infra/modules/idp-hook/main.tf) now
# matches exactly these four statuses plus SUCCEEDED -- keep this tuple and that rule's status list
# in sync, or a status this handler is prepared to act on will simply never be delivered.
TERMINAL_NON_SUCCEEDED = ("FAILED", "TIMED_OUT", "ABORTED")


def _object_key(document: dict) -> str | None:
    """Resolve the IDP document id from a (resolved) tracking record.

    Mirrors ``mapper._derive_output_location``'s object_key fallback chain exactly, duplicated
    rather than imported: that function also resolves the output bucket/prefix, which this
    tracking-only path never reads (there is no extraction to embed for a document that never
    produced -- or that recon could not map to -- a notice).

    :param document: the resolved IDP tracking record (PascalCase; snake_case tolerated).
    :returns: the document id, or None if the record carries none of the recognised keys.
    """
    return document.get("ObjectKey") or document.get("id") or document.get("document_id")


def _failure_reason(*, document: dict, status: str, mapper_error: str | None) -> str:
    """Pick the best available explanation for why no Notice exists for this document.

    Preference order:

    1. The resolved record's OWN ``errors``/``Errors`` field, when it carries one. IDP's own
       tracking record describes a genuine pipeline failure (a crash, a timeout, a bad extraction)
       better than recon's mapping code ever could -- recon only sees the aftermath.
    2. The mapper's ``ValueError`` text, when the execution SUCCEEDED but recon could not map the
       result (e.g. no extractable ``notice_date``). This describes only recon's mapping step, not
       the pipeline run, which is why it is the fallback and not the first choice.
    3. A generic message naming the raw execution status, so a terminal non-SUCCEEDED execution
       whose own record carries no ``errors`` field either still gets a row that says SOMETHING,
       rather than one whose ``notice_failure_reason`` is blank.

    :param document: the resolved IDP tracking record.
    :param status: the raw ``detail.status`` this invocation was fired for.
    :param mapper_error: the text of the ``ValueError`` :func:`idp_event_to_notice` raised, or None
        when this call did not originate from that catch (the terminal-non-SUCCEEDED path).
    :returns: a non-blank human-readable reason.
    """
    errors = document.get("errors") or document.get("Errors")
    if errors:
        return str(errors)
    if mapper_error is not None:
        return mapper_error
    return f"IDP execution ended with status {status!r} and its own record reported no error detail"


def _document_record(
    *,
    object_key: str | None,
    idp_tracking: dict,
    execution_arn: str | None,
    failure_reason: str,
) -> dict:
    """Build the tracking-only row for a document recon could not map to a Notice.

    :param object_key: the IDP document id, used to build the shared ``notice_id`` namespace.
    :param idp_tracking: the tracking snapshot built by :func:`build_tracking_snapshot`.
    :param execution_arn: the IDP Step-Function run id, for the audit trail.
    :param failure_reason: why no notice was mapped, from :func:`_failure_reason`.
    :returns: the plain dict to pass to ``NoticeStore.put_document_record``.
    """
    return {
        # SAME id namespace a notice for this document would use -- not a separate one -- so a
        # document that FAILS and is later reprocessed successfully overwrites its own tracking
        # row instead of leaving two rows in the Documents tab forever.
        "notice_id": f"idp-{object_key}",
        "record_kind": "document",
        "source_document": object_key,
        "parse_method": PARSE_METHOD_IDP,
        "idp_tracking": idp_tracking,
        "idp_execution_arn": execution_arn or "",
        "notice_failure_reason": failure_reason,
    }


def handle(event, _context) -> dict:
    """Map an IDP completion event to a Notice, or a tracking-only row, and store it.

    Re-delivery needs no idempotency guard: ``notice_id`` is deterministic (``idp-<ObjectKey>``)
    and both write paths overwrite (``put`` unconditionally, ``put_document_record`` conditionally
    -- see that method), so the same event lands on the same row. A genuine reprocess (a new IDP
    run) simply replaces the stale extraction or tracking row — there is no case to re-drive.

    :param event: the EventBridge event carrying IDP's Step-Function completion detail.
    :param _context: the Lambda context (unused).
    :returns: ``{"written": n, "notice_id": id_or_None}`` (the terminal-non-SUCCEEDED path also
        carries ``"kind": "document"``).
    :raises ValueError: when the execution SUCCEEDED but no notice could be mapped (e.g. no
        extractable notice_date). The tracking row is written FIRST -- see the comment at the
        raise site for why this is the one place in the module that catches and re-raises rather
        than simply letting the exception propagate.
    :raises Exception: re-raises unexpected errors so IDP's retry/DLQ engages.
    """
    # Log the raw event once — the real IDP shape was undocumented and cost us a silent
    # field-drop; keep this so future shape changes are diagnosable from CloudWatch.
    logger.info("idp-hook event: %s", json.dumps(event, default=str)[:4000])

    detail = event.get("detail", {})
    status = detail.get("status")
    if status not in ("SUCCEEDED", *TERMINAL_NON_SUCCEEDED):
        return {"written": 0, "notice_id": None}

    output = detail.get("output")
    parsed = json.loads(output) if isinstance(output, str) else (output or {})
    document = parsed.get("document") or parsed  # tolerate either shape
    execution_arn = detail.get("executionArn")  # the IDP run id, kept for the audit trail

    # Reader pulls extracted values from IDP output S3 at ingest. Without a reachable bucket we
    # still capture what the event itself carries (classification/sections).
    reader = IdpOutputReader()
    # IDP compresses any output too large for Step Functions' 256 KB cap, leaving only a pointer in
    # the event. Resolve it BEFORE anything else reads `document`: the stand-in's `sections` is a
    # list of id strings, not records, and it names neither the output bucket nor the input key.
    # Every succeeded execution in recon-dev is compressed, so this is the normal path -- and a
    # terminal non-SUCCEEDED execution's own tracking record can be compressed too.
    document = reader.resolve_document(document)

    # Built ONCE regardless of outcome, from the resolved document plus the raw detail, so the
    # SUCCEEDED-and-mapped branch and both tracking-row branches below can never disagree on what a
    # given tracking field means or how it falls back -- see tracking.py's module docstring.
    snapshot = build_tracking_snapshot(document=document, detail=detail)

    if status in TERMINAL_NON_SUCCEEDED:
        # A FAILED/TIMED_OUT/ABORTED execution produced no extraction at all, so there is no Notice
        # to attempt here -- go straight to the tracking-only row.
        object_key = _object_key(document)
        reason = _failure_reason(document=document, status=status, mapper_error=None)
        record = _document_record(
            object_key=object_key,
            idp_tracking=snapshot,
            execution_arn=execution_arn,
            failure_reason=reason,
        )
        NoticeStore(table_name=os.environ["NOTICES_TABLE"]).put_document_record(record=record)
        logger.info(
            "idp-hook wrote tracking-only row for notice_id=%s status=%s reason=%s",
            record["notice_id"],
            status,
            reason,
        )
        return {"written": 1, "notice_id": None, "kind": "document"}

    # status == "SUCCEEDED" from here on.
    try:
        notice = idp_event_to_notice(
            document, output_reader=reader, execution_arn=execution_arn, idp_tracking=snapshot
        )
    except ValueError as exc:
        # THE one place this module bends its own fail-loudly convention: catch, write, re-raise --
        # never catch-and-swallow. A SUCCEEDED execution whose document extracted nothing recon
        # could map (e.g. no notice_date) must still leave the document VISIBLE to an operator in
        # the Documents tab, not only as a CloudWatch line. Writing the tracking row first makes
        # that true. Re-raising immediately after is what keeps this loud: EventBridge's
        # retry/DLQ still engages exactly as it did before this row existed, so a genuine mapping
        # bug is not hidden behind "well, at least SOMETHING got written". Catching only
        # ValueError (never a bare `except` or `except Exception`) keeps this narrow to the one
        # failure mode the mapper raises on purpose; anything else (e.g. a boto3 ClientError) is
        # left to propagate unchanged, same as before this branch existed.
        object_key = _object_key(document)
        reason = _failure_reason(document=document, status=status, mapper_error=str(exc))
        record = _document_record(
            object_key=object_key,
            idp_tracking=snapshot,
            execution_arn=execution_arn,
            failure_reason=reason,
        )
        NoticeStore(table_name=os.environ["NOTICES_TABLE"]).put_document_record(record=record)
        logger.warning(
            "idp-hook wrote tracking-only row for notice_id=%s after a mapping failure: %s",
            record["notice_id"],
            reason,
        )
        raise

    # Copy page previews into recon's own assets bucket so the UI serves them same-origin
    # (best-effort — ingest never fails on a preview copy). This S3 read is the one sanctioned
    # IDP coupling; see the module docstring.
    assets_bucket = os.environ.get("ASSETS_BUCKET", "")
    if assets_bucket and notice.idp_pages:
        notice.idp_pages = reader.copy_pages(
            notice.idp_pages, dest_bucket=assets_bucket, item_id=notice.notice_id
        )

    # os.environ[...] not .get(..., "recon-notices"): a misconfigured hook must fail its invocation
    # and land in the DLQ, not silently write to a table name that is only right in dev.
    NoticeStore(table_name=os.environ["NOTICES_TABLE"]).put(notice=notice)

    # The search index, from the SAME extraction in the same invocation. Written after the notice on
    # purpose: a posting pointing at a notice that does not exist yet would let a search return an id
    # the caller cannot then read, whereas a notice with no postings yet is merely not findable by
    # field for a moment.
    #
    # A failure here does NOT swallow: it raises, EventBridge retries, and `reindex` is idempotent
    # (delete-then-write keyed on (field, value)), so the retry converges rather than duplicating.
    # Degrading to "notice written, index skipped" would be worse than failing -- the notice would be
    # invisible to every field search while looking perfectly healthy in the table and on the
    # Documents tab.
    indexed = NoticeSearchIndex(table_name=os.environ["NOTICE_SEARCH_TABLE"]).reindex(
        notice_id=notice.notice_id,
        fields=flatten_sections(notice.idp_sections),
    )
    logger.info(
        "idp-hook wrote notice_id=%s class=%s postings=%d",
        notice.notice_id,
        notice.notice_class,
        indexed,
    )
    return {"written": 1, "notice_id": notice.notice_id, "postings": indexed}
