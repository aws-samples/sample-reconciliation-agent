"""Debounced, serialized knowledge-base ingestion for operator uploads.

An object put into the assets bucket's ``knowledge-base/uploads/`` prefix is not in the corpus. A
Bedrock knowledge base only reflects an S3 prefix after an ingestion job has scanned it, so the
upload route leaves such a file at ``PENDING_INGESTION`` and this Lambda moves it on.

It is triggered by S3 notifications routed through an SQS delay queue, and runs at reserved
concurrency 1. Both are load-bearing: ``StartIngestionJob`` fails while a job is already in flight,
so an operator dropping six files would otherwise start six jobs and five would error.

The handler never waits for a job. It does one pass of work and, when there is more to do, returns
its messages to the queue as batch item failures so a later invocation continues. A job takes about
a minute against this KB, and blocking a Lambda for that while holding the only concurrency slot
would serialize the *waiting* as well as the work.

It deliberately ignores a job's ``statistics``. A managed-KB job has reported
``numberOfDocumentsFailed: 0`` while silently dropping five documents, so the only question this
module asks is whether ``ListKnowledgeBaseDocuments`` contains the key.
"""

from __future__ import annotations

import datetime as dt
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

# Newest-first, because the only job that matters is the most recent one. The API takes this
# structure verbatim; there is no shorthand.
_SORT_NEWEST_FIRST = {"attribute": "STARTED_AT", "order": "DESCENDING"}

# A job that has been asked for but has not settled. StartIngestionJob rejects a second one while
# any of these is outstanding.
_IN_FLIGHT_STATUSES = frozenset({"STARTING", "IN_PROGRESS"})

# How far back to look for submissions with unfinished files. A pending upload is by definition
# recent, and the recency index is queried newest-first, so this is a bound on work rather than a
# correctness limit -- but it IS a limit: a file still pending after this many later submissions
# will never be revisited, and that is a bug to fix rather than a number to raise.
_MAX_SUBMISSIONS_SCANNED = 200


def _required(name: str) -> str:
    """Read a required environment variable.

    :param name: The variable's name.
    :returns: Its value.
    :raises RuntimeError: When it is unset. Every one of these names a resource this Lambda cannot
        invent, and a default would make it operate on the wrong knowledge base in silence.
    """
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set, so this Lambda does not know what to ingest")
    return value


def _agent() -> Any:
    """Return a bedrock-agent client. A function, not a module constant, so tests can replace it.

    :returns: The boto3 ``bedrock-agent`` client.
    """
    return boto3.client("bedrock-agent")


def _table() -> Any:
    """Return the uploads table resource. A function so tests can replace it.

    :returns: The boto3 DynamoDB ``Table`` for the uploads audit table.
    """
    return boto3.resource("dynamodb").Table(_required("UPLOADS_TABLE"))


def _job_state() -> tuple[bool, dt.datetime | None]:
    """Ask the data source what its ingestion jobs are doing.

    :returns: A pair of (whether a job is in flight, when the newest COMPLETE job started). The
        second value is ``None`` when the data source has never completed a job, which happens only
        on a brand-new deployment.
    """
    summaries = _agent().list_ingestion_jobs(
        knowledgeBaseId=_required("KB_ID"),
        dataSourceId=_required("KB_DATA_SOURCE_ID"),
        sortBy=_SORT_NEWEST_FIRST,
        maxResults=10,
    )["ingestionJobSummaries"]
    in_flight = any(job["status"] in _IN_FLIGHT_STATUSES for job in summaries)
    completed = [job["startedAt"] for job in summaries if job["status"] == "COMPLETE"]
    return in_flight, completed[0] if completed else None


def _indexed_uris() -> set[str]:
    """List every document the knowledge base currently holds.

    Paginated deliberately. The live corpus already exceeds one page, and an unfollowed
    ``nextToken`` would report perfectly good documents as absent -- which this module turns into a
    FAILED row shown to the operator.

    :returns: The set of ``s3://bucket/key`` URIs whose status is INDEXED.
    """
    client = _agent()
    kb_id = _required("KB_ID")
    ds_id = _required("KB_DATA_SOURCE_ID")
    uris: set[str] = set()
    token: str | None = None
    while True:
        page = client.list_knowledge_base_documents(
            knowledgeBaseId=kb_id,
            dataSourceId=ds_id,
            maxResults=100,
            **({"nextToken": token} if token else {}),
        )
        for detail in page.get("documentDetails", []):
            # Only INDEXED counts. A document can be listed while still PENDING or after a
            # DELETE_IN_PROGRESS, and neither is retrievable.
            if detail.get("status") == "INDEXED":
                uris.add(detail["identifier"]["s3"]["uri"])
        token = page.get("nextToken")
        if not token:
            return uris


def _pending_submissions() -> list[dict[str, Any]]:
    """Read knowledge-base submissions that still have unfinished files.

    :returns: The matching rows, newest first.
    """
    response = _table().query(
        IndexName="by_recency",
        KeyConditionExpression=Key("gsi_bucket").eq("submission"),
        ScanIndexForward=False,
        Limit=_MAX_SUBMISSIONS_SCANNED,
    )
    return [
        row
        for row in response.get("Items", [])
        if row.get("route") == "knowledge-base"
        and any(f.get("status") == "PENDING_INGESTION" for f in row.get("files", []))
    ]


def _kb_keys(file_row: dict[str, Any]) -> list[str]:
    """Which object keys of a file row the knowledge base is expected to hold.

    An email's own row points at the staged ``.msg`` in ``uploads/inbox/``, which is NOT under the
    data source's prefix and will never be indexed. What was ingested is the parts it produced.

    :param file_row: One entry of a submission's ``files`` list.
    :returns: The keys to look for in the corpus.
    """
    derived = file_row.get("derived_object_keys") or []
    return list(derived) if derived else [file_row["object_key"]]


def _decide(
    *,
    file_row: dict[str, Any],
    indexed: set[str],
    bucket: str,
    row_uploaded_at: str,
    newest_complete: dt.datetime | None,
) -> tuple[str, str | None]:
    """Work out what a pending file's status should now be.

    :param file_row: The file entry under consideration.
    :param indexed: Every ``s3://`` URI the corpus holds.
    :param bucket: The assets bucket, used to build the URIs to look for.
    :param row_uploaded_at: The submission's ``uploaded_at``, ISO-8601. Deliberately NOT
        ``status_updated_at``: this handler bumps that attribute on every pass, so comparing
        against it would move the deadline forward each time it ran and a file that was never
        indexed would sit at PENDING_INGESTION forever instead of failing.
    :param newest_complete: When the newest COMPLETE job started, or None if there has never been
        one.
    :returns: A pair of (new status, error message or None).
    """
    wanted = {f"s3://{bucket}/{key}" for key in _kb_keys(file_row)}
    if wanted <= indexed:
        return "INGESTED", None
    # Not in the corpus. Whether that is a failure depends entirely on whether a job has had the
    # chance to see it: a job that started BEFORE the upload has not scanned it yet.
    uploaded_at = dt.datetime.fromisoformat(row_uploaded_at.replace("Z", "+00:00"))
    if newest_complete is not None and newest_complete > uploaded_at:
        missing = sorted(wanted - indexed)
        return "FAILED", (
            "the ingestion job that ran after this upload did not index "
            + ", ".join(missing)
            + ". Re-upload the file; if it fails again the document is being dropped silently."
        )
    return "PENDING_INGESTION", None


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """Advance every pending knowledge-base upload by one step.

    :param event: An SQS batch. The message bodies are not read: each one means only "something
        changed under the uploads prefix", and the handler works out the rest from the table.
    :param _context: The Lambda context, unused.
    :returns: An SQS partial-batch response. A non-empty ``batchItemFailures`` returns the messages
        to the queue, which is how this Lambda schedules its own next pass.
    :raises RuntimeError: When its configuration is incomplete.
    """
    message_ids = [record["messageId"] for record in event.get("Records", [])]
    redrive = {"batchItemFailures": [{"itemIdentifier": mid} for mid in message_ids]}
    done: dict[str, Any] = {"batchItemFailures": []}

    # All four up front, before any client is constructed. Discovering a missing variable halfway
    # through means some rows have been rewritten and the rest have not.
    for name in ("KB_ID", "KB_DATA_SOURCE_ID", "UPLOADS_TABLE", "ASSETS_BUCKET"):
        _required(name)
    bucket = _required("ASSETS_BUCKET")

    in_flight, newest_complete = _job_state()
    if in_flight:
        # Nothing useful to do: a second job would be rejected, and the corpus will not have
        # changed until this one finishes. Come back after the visibility timeout.
        print("an ingestion job is already in flight; returning the batch to the queue")
        return redrive

    pending_rows = _pending_submissions()
    if not pending_rows:
        print("no submission has a file waiting on ingestion")
        return done

    # Listed once for the whole batch, not once per row: it is the same paginated read every time,
    # and the corpus cannot change while no job is running.
    indexed = _indexed_uris()

    still_pending = False
    for row in pending_rows:
        updated_files = []
        changed = False
        for file_row in row["files"]:
            if file_row.get("status") != "PENDING_INGESTION":
                updated_files.append(file_row)
                continue
            status, error = _decide(
                file_row=file_row,
                indexed=indexed,
                bucket=bucket,
                row_uploaded_at=row["uploaded_at"],
                newest_complete=newest_complete,
            )
            still_pending = still_pending or status == "PENDING_INGESTION"
            changed = changed or status != "PENDING_INGESTION"
            updated_files.append(
                {**file_row, "status": status, **({"error": error} if error else {})}
            )
        if changed:
            _write_files(submission_id=row["submission_id"], files=updated_files)
    return _maybe_start(still_pending=still_pending, redrive=redrive, done=done)


def _write_files(*, submission_id: str, files: list[dict[str, Any]]) -> None:
    """Replace a submission's ``files`` list.

    A whole-list write rather than an indexed update, matching what the BFF's ``markFileStatus``
    does, and safe for the same reason: this Lambda runs at reserved concurrency 1 and the route
    only writes a file once, at creation.

    :param submission_id: The row to update.
    :param files: The new list.
    :returns: Nothing.
    """
    _table().update_item(
        Key={"submission_id": submission_id},
        UpdateExpression="SET files = :files, status_updated_at = :touched",
        ExpressionAttributeValues={
            ":files": files,
            ":touched": dt.datetime.now(dt.UTC).isoformat(),
        },
    )


def _maybe_start(
    *, still_pending: bool, redrive: dict[str, Any], done: dict[str, Any]
) -> dict[str, Any]:
    """Start a job when something is still waiting, and decide whether to re-drive the batch.

    :param still_pending: Whether any file is waiting for a job that has not run yet.
    :param redrive: The response that returns the batch to the queue.
    :param done: The response that acknowledges it.
    :returns: One of the two responses.
    """
    if not still_pending:
        # Every file settled, one way or the other. Acknowledging the batch here is what stops the
        # loop; a FAILED file is settled too, and retrying it forever would bury it.
        return done
    job_id = _agent().start_ingestion_job(
        knowledgeBaseId=_required("KB_ID"),
        dataSourceId=_required("KB_DATA_SOURCE_ID"),
    )["ingestionJob"]["ingestionJobId"]
    print(f"started ingestion job {job_id}")
    # Re-driven so a later invocation can flip the rows once this job finishes. The queue's
    # maxReceiveCount bounds how long that is allowed to take before the messages land in the DLQ.
    return redrive
