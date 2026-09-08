"""Turns an uploaded email into documents the upload route can forward.

Called synchronously by the BFF's upload route, once per uploaded `.msg` or `.eml`.

The bytes do not travel in the invoke payload. Lambda caps a synchronous request at 6 MB and
the upload allowlist permits 100 MB, so the route writes the raw email into recon's own assets
bucket first and passes only the object's key. This handler reads it there, writes each derived
part back to the same bucket, and returns a manifest. The route then copies each part to its
real destination server-side, so the file's bytes never pass through the web task at all.

Deriving into recon's bucket rather than straight into a destination is deliberate. A part bound
for the knowledge base needs a sidecar written beside it under a particular prefix; a part bound
for the document pipeline needs `config-version` metadata and no prefix. Neither of those
belongs in a function whose only expertise is reading email.

Two failure modes are separated on purpose:

  - A refusable email -- no plain-text body, an attachment type that is not accepted, too many
    parts -- returns {"parts": [], "error": "<reason>"}. The route shows that reason against
    that file, and the rest of the submission proceeds. Raising here would surface as a generic
    invocation failure and tell the operator nothing about which file was at fault.
  - A missing source object, or an unwritable bucket, raises. That is not something the operator
    did; it means the route's own put did not happen or the deployment is misconfigured, and
    turning it into a per-file message would hide a broken deployment.
"""

from __future__ import annotations

import os
from typing import Any

import boto3

from backend.email_preprocess.parts import PartKind, UnsupportedEmail, split_upload
from backend.email_preprocess.render import render_body_pdf


def _s3() -> Any:
    """Build an S3 client.

    Built per call, not once at import, and this is the convention every backend module here
    follows. A module-level client is constructed while the test file is being COLLECTED, which
    is before moto's `mock_aws` has patched anything -- so the client talks to real AWS, and in
    an environment with no region configured the import itself fails with NoRegionError.

    Returns:
        A boto3 S3 client.
    """
    return boto3.client("s3")


# Where the raw uploads and the derived parts both live. recon's own assets bucket -- never a
# destination bucket, because anything landing in the document pipeline's input bucket is
# extracted immediately, and a half-written derived part is not a document.
_STAGING_BUCKET_ENV = "UPLOAD_STAGING_BUCKET"

# Content types for the attachment extensions parts.py accepts. An attachment copied to a
# destination with the wrong content type is still extracted, but the knowledge-base connector
# picks its parser from this, so a wrong value there means a document that indexes as garbage.
_CONTENT_TYPES: dict[str, str] = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".txt": "text/plain",
}


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """Split one uploaded email into derived documents.

    Args:
        event: Must carry "submission_id", "source_key", and "filename". source_key is the
            object this handler reads; filename is the name the operator uploaded, which
            selects the parser and appears in error messages.
        _context: The Lambda context. Unused.

    Returns:
        {"parts": [...], "error": ""} on success, or {"parts": [], "error": "<reason>"} when
        the email cannot be split. Each part carries: kind, key, filename, content_type,
        subject, sender, recipients, message_id, received_date, and -- for attachments --
        attachment_format.

    Raises:
        KeyError: A required event field is missing.
        botocore.exceptions.ClientError: The source object could not be read, or a derived
            part could not be written.
    """
    submission_id = event["submission_id"]
    source_key = event["source_key"]
    filename = event["filename"]
    bucket = os.environ[_STAGING_BUCKET_ENV]
    s3 = _s3()

    raw = s3.get_object(Bucket=bucket, Key=source_key)["Body"].read()

    try:
        split = split_upload(raw=raw, filename=filename)
    except UnsupportedEmail as exc:
        return {"parts": [], "error": str(exc)}

    manifest: list[dict[str, Any]] = []
    for index, part in enumerate(split):
        # The index prefixes every derived key. Two attachments in one email may carry the same
        # declared filename, and without the index the second would overwrite the first --
        # losing a document while the manifest still claimed two.
        if part.kind is PartKind.BODY:
            try:
                content = render_body_pdf(subject=part.subject, sender=part.sender, body=part.text)
            except ValueError as exc:
                return {"parts": [], "error": f"{filename}: {exc}"}
            derived_name = f"{_stem(filename)}.pdf"
            content_type = "application/pdf"
            attachment_format = ""
        else:
            content = part.content
            derived_name = part.filename
            content_type = _CONTENT_TYPES[part.extension]
            attachment_format = part.extension.lstrip(".")

        key = f"uploads/derived/{submission_id}/{index:02d}-{derived_name}"
        s3.put_object(Bucket=bucket, Key=key, Body=content, ContentType=content_type)

        manifest.append(
            {
                "kind": part.kind.value,
                "key": key,
                "filename": derived_name,
                "content_type": content_type,
                "attachment_format": attachment_format,
                "subject": part.subject,
                "sender": part.sender,
                "recipients": list(part.recipients),
                "message_id": part.message_id,
                "received_date": part.received_date,
            }
        )

    return {"parts": manifest, "error": ""}


def _stem(filename: str) -> str:
    """Return a filename without its extension.

    Args:
        filename: The filename, with or without an extension.

    Returns:
        Everything before the final dot, or the whole name if there is no dot.
    """
    return filename[: filename.rfind(".")] if "." in filename else filename
