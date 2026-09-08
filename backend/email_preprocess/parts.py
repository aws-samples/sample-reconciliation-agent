"""Splits an email into the parts that can actually be uploaded.

Nothing downstream can read an email. The document pipeline's configuration accepts PDF and
DOCX; the knowledge base's connector does not parse `.msg` at all. So an emailed notice is
split here into a body -- later rendered to PDF -- plus each attachment as its own document.

Two rules in this module are security decisions, not conveniences:

  1. Only the text/plain body is ever read. An HTML body from a counterparty carries remote
     image references, and anything that resolves them makes an outbound request from inside
     the VPC on attacker-chosen input, while confirming to the sender that the message was
     opened. There is no rendering path for HTML here and there should never be one.
  2. Everything is bounded before it is trusted: nesting depth, attachment count, attachment
     size, and the attachment's extension. An email is the one input to this system that
     arrives unsolicited from outside, so each limit is checked rather than assumed.

Both rules fail loudly. An email that breaks one raises UnsupportedEmail with the specific
reason, which the upload route shows against that file. Silently dropping an attachment would
be the worst outcome available: the operator would believe a complete notice had been uploaded.
"""

from __future__ import annotations

import email
import email.message
import email.policy
from dataclasses import dataclass
from enum import Enum

# Extensions an attachment may have. Deliberately narrower than the upload allowlist: this is
# unsolicited third-party content, so macro-enabled Office formats and archives are out.
ALLOWED_ATTACHMENT_EXTENSIONS: frozenset[str] = frozenset(
    {".pdf", ".docx", ".xlsx", ".csv", ".txt"}
)

# A notice with more parts than this is not a notice. The cap exists so one crafted message
# cannot turn a single upload into hundreds of downstream extraction jobs.
MAX_ATTACHMENTS: int = 25

# Per-attachment ceiling. The pipeline's own limit is higher, but a part this large in an
# email is a sign of something other than a notice.
MAX_ATTACHMENT_BYTES: int = 25 * 1024 * 1024

# How far into attached messages to follow. 1 means: the email, plus one forwarded message
# inside it. Forwarded notices are ordinary; a chain deeper than that is not, and recursion
# on attacker-supplied structure needs a hard floor rather than a hopeful one.
MAX_NESTING_DEPTH: int = 1


class UnsupportedEmail(Exception):
    """Raised when an email cannot be split into uploadable parts.

    The message is shown to the operator against the offending file, so it names what was
    wrong and which part caused it.
    """


class PartKind(str, Enum):
    """What a split part is, which decides how it is uploaded."""

    BODY = "body"
    ATTACHMENT = "attachment"


@dataclass(frozen=True)
class EmailPart:
    """One uploadable piece of an email.

    Attributes:
        kind: BODY parts carry text to be rendered; ATTACHMENT parts carry bytes as-is.
        subject: Subject of the message this part came from. Used as the document title and
            written into the knowledge-base sidecar.
        sender: The From address of the message this part came from, or "" if absent.
        recipients: The To addresses, which the sidecar stores as a list.
        message_id: The RFC 5322 Message-ID, or "" if absent. Carried so a re-upload of the
            same email is recognisable after the fact.
        received_date: The Date header, unparsed, or "" if absent.
        text: For BODY parts, the text/plain body. Empty for attachments.
        filename: For ATTACHMENT parts, the declared filename. Empty for bodies.
        extension: For ATTACHMENT parts, the lowercased extension including the dot.
        content: For ATTACHMENT parts, the decoded bytes. Empty for bodies.
    """

    kind: PartKind
    subject: str
    sender: str
    recipients: tuple[str, ...]
    message_id: str
    received_date: str
    text: str = ""
    filename: str = ""
    extension: str = ""
    content: bytes = b""


def split_upload(*, raw: bytes, filename: str) -> list[EmailPart]:
    """Split an uploaded email of either supported type into uploadable parts.

    This is the entry point the Lambda calls. It exists so no caller has to know that `.eml`
    is parsed by the standard library and `.msg` by extract_msg -- and so the bounds in this
    module apply to both without being restated.

    Args:
        raw: The uploaded file's bytes.
        filename: The uploaded filename. Its extension selects the parser and appears in
            every error message.

    Returns:
        The parts, body first, exactly as split_email returns them.

    Raises:
        UnsupportedEmail: The extension is neither .eml nor .msg, or the message breaks one
            of this module's bounds.
    """
    extension = filename[filename.rfind(".") :].lower() if "." in filename else ""
    if extension == ".eml":
        return split_email(raw=raw, filename=filename, depth=0)
    if extension == ".msg":
        return _split_outlook_msg(raw=raw, filename=filename)
    raise UnsupportedEmail(f"{filename}: {extension or '(no extension)'} is not an email file")


def split_email(*, raw: bytes, filename: str, depth: int) -> list[EmailPart]:
    """Split an RFC 5322 message into its uploadable parts.

    Args:
        raw: The raw message bytes.
        filename: The uploaded filename, used only in error messages.
        depth: How many attached messages deep this call already is. Callers pass 0.

    Returns:
        The body part first, then one part per attachment, then the parts of any attached
        message, in that order. The body is always present -- an email without a readable
        text body raises rather than returning an empty list.

    Raises:
        UnsupportedEmail: The message has no text/plain body, exceeds a bound, or carries an
            attachment whose type is not accepted.
    """
    if depth > MAX_NESTING_DEPTH:
        raise UnsupportedEmail(
            f"{filename}: nesting depth exceeds {MAX_NESTING_DEPTH}; forward the notice itself"
        )

    # policy=default gives header values already decoded from RFC 2047 encoded-words, so a
    # subject with non-ASCII characters arrives as text rather than "=?utf-8?B?...?=".
    message = email.message_from_bytes(raw, policy=email.policy.default)

    header = {
        "subject": str(message.get("Subject", "")),
        "sender": str(message.get("From", "")),
        "recipients": tuple(a.strip() for a in str(message.get("To", "")).split(",") if a.strip()),
        "message_id": str(message.get("Message-ID", "")),
        "received_date": str(message.get("Date", "")),
    }

    # get_body with preferencelist=("plain",) is the single place the plain-only rule is
    # enforced. Passing "html" here, or falling back to it when plain is missing, is what
    # the "never render HTML" rule forbids -- so a missing plain body is an error, not a
    # reason to reach for the other one.
    body = message.get_body(preferencelist=("plain",))
    if body is None:
        raise UnsupportedEmail(
            f"{filename}: no text/plain body. Ask the sender for a PDF, or forward the "
            "attachment on its own."
        )

    parts: list[EmailPart] = [EmailPart(kind=PartKind.BODY, text=body.get_content(), **header)]
    parts.extend(_attachment_parts(message=message, filename=filename, header=header))
    parts.extend(_nested_parts(message=message, filename=filename, depth=depth))
    return parts


def _attachment_parts(
    *, message: email.message.EmailMessage, filename: str, header: dict[str, object]
) -> list[EmailPart]:
    """Turn each non-message attachment into a part, checking every bound.

    Args:
        message: The parsed message.
        filename: The uploaded filename, for error messages.
        header: The shared header fields, spread into each part.

    Returns:
        One part per accepted attachment.

    Raises:
        UnsupportedEmail: Too many attachments, one too large, or one of a refused type.
    """
    # iter_attachments skips the body parts, so an inline image referenced by an HTML
    # alternative does not arrive here as a surprise document.
    attachments = [
        part for part in message.iter_attachments() if part.get_content_type() != "message/rfc822"
    ]
    if len(attachments) > MAX_ATTACHMENTS:
        raise UnsupportedEmail(
            f"{filename}: attachment count {len(attachments)} exceeds {MAX_ATTACHMENTS}"
        )

    parts: list[EmailPart] = []
    for part in attachments:
        name = part.get_filename()
        if not name:
            # A nameless attachment has no extension to check, so there is no way to decide
            # it is safe. Refusing names the problem; skipping it would hide a document.
            raise UnsupportedEmail(f"{filename}: an attachment has no filename")
        extension = name[name.rfind(".") :].lower() if "." in name else ""
        if extension not in ALLOWED_ATTACHMENT_EXTENSIONS:
            raise UnsupportedEmail(
                f"{filename}: attachment {name} has type {extension or '(none)'}, which is "
                "not accepted"
            )
        content = part.get_payload(decode=True)
        # Checked, because `decode=True` returns None -- not b"" -- for a part whose transfer
        # encoding it cannot decode, and a malformed attachment is exactly the input a hostile
        # sender controls. Unchecked, the next line raises `TypeError: object of type 'NoneType'
        # has no len()`, which the handler does not catch, so one bad attachment turns a
        # refusable email into a generic invocation failure with no filename in it.
        if content is None:
            raise UnsupportedEmail(
                f"{filename}: attachment {name} could not be decoded, so its contents are unknown"
            )
        if len(content) > MAX_ATTACHMENT_BYTES:
            raise UnsupportedEmail(
                f"{filename}: attachment {name} is {len(content)} bytes, over the "
                f"{MAX_ATTACHMENT_BYTES} limit"
            )
        parts.append(
            EmailPart(
                kind=PartKind.ATTACHMENT,
                filename=name,
                extension=extension,
                content=content,
                **header,
            )
        )
    return parts


def _nested_parts(
    *, message: email.message.EmailMessage, filename: str, depth: int
) -> list[EmailPart]:
    """Split any attached message, one level deeper.

    Args:
        message: The parsed message.
        filename: The uploaded filename, for error messages.
        depth: This message's depth. The recursive call gets depth + 1.

    Returns:
        The parts of every attached message, flattened.

    Raises:
        UnsupportedEmail: Propagated from the recursive call, including the depth refusal.
    """
    parts: list[EmailPart] = []
    for part in message.iter_attachments():
        if part.get_content_type() != "message/rfc822":
            continue
        # get_payload() on a message/rfc822 part returns a one-element list holding the
        # parsed inner message, not bytes -- so re-serialise it and let split_email parse it
        # the same way it parses a top-level upload. One code path, one set of bounds.
        inner = part.get_payload()[0]
        parts.extend(split_email(raw=inner.as_bytes(), filename=filename, depth=depth + 1))
    return parts


def _split_outlook_msg(*, raw: bytes, filename: str) -> list[EmailPart]:
    """Parse an Outlook .msg container and split it.

    extract_msg opens a path rather than bytes, so the upload is written to a temporary file
    for the duration of the parse and removed with it.

    Args:
        raw: The .msg file's bytes.
        filename: The uploaded filename, for error messages.

    Returns:
        The parts, as split_email returns them.

    Raises:
        UnsupportedEmail: The container could not be parsed, or the message breaks a bound.
    """
    import tempfile

    import extract_msg

    with tempfile.NamedTemporaryFile(suffix=".msg") as scratch:
        scratch.write(raw)
        scratch.flush()
        try:
            parsed = extract_msg.Message(scratch.name)
        except Exception as exc:
            # extract_msg raises a range of container-specific errors on malformed input. The
            # operator can do nothing with any of them, so they all become the same
            # actionable message -- but the original is chained so it reaches CloudWatch.
            raise UnsupportedEmail(f"{filename}: could not be read as an Outlook message") from exc
        return _split_parsed_msg(parsed=parsed, filename=filename)


def _split_parsed_msg(*, parsed: object, filename: str) -> list[EmailPart]:
    """Convert a parsed Outlook message into an EmailMessage and split that.

    Rebuilding the message in the standard library's own type is what keeps the .msg path from
    growing a second copy of the bounds and the plain-text-only rule: after this function, both
    formats go through split_email unchanged.

    Args:
        parsed: An extract_msg.Message, or any object exposing subject, sender, to,
            messageId, date, body, and attachments.
        filename: The uploaded filename, for error messages.

    Returns:
        The parts, as split_email returns them.

    Raises:
        UnsupportedEmail: The message has no body, or breaks one of this module's bounds.
    """
    rebuilt = email.message.EmailMessage(policy=email.policy.default)
    for header, value in (
        ("Subject", parsed.subject),
        ("From", parsed.sender),
        ("To", parsed.to),
        ("Message-ID", parsed.messageId),
        ("Date", parsed.date),
    ):
        if value:
            rebuilt[header] = str(value)

    # .msg exposes the plain-text body as `body`, and an HTML-only Outlook message leaves it
    # None. That is refused here rather than after the rebuild, because add_attachment on a
    # message whose content was never set has no body part to convert to multipart. The
    # wording matches the .eml refusal so the operator sees one message for one situation.
    if not parsed.body:
        raise UnsupportedEmail(
            f"{filename}: no text/plain body. Ask the sender for a PDF, or forward the "
            "attachment on its own."
        )
    rebuilt.set_content(str(parsed.body))

    for attachment in parsed.attachments:
        name = attachment.longFilename or ""
        # application/octet-stream is deliberate: the bounds check reads the extension off
        # get_filename(), not the content type, so inventing a more specific type here would
        # add a second, unread claim about the same file.
        rebuilt.add_attachment(
            attachment.data or b"",
            maintype="application",
            subtype="octet-stream",
            filename=name,
        )

    return split_email(raw=rebuilt.as_bytes(), filename=filename, depth=0)
