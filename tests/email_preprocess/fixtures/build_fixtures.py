"""Builds the synthetic email fixtures the pre-processor tests read.

Every fixture is generated here rather than committed as a binary blob, so a reviewer can
see exactly what is being parsed. All addresses and names are invented -- no real
correspondence is ever used as a test fixture.
"""

import email
import email.policy
from email.message import EmailMessage

# The remote image in the HTML alternative below. Its only job is to be findable: a test
# asserts this string never appears in the parsed body, which is how "we never read the HTML
# part" is verified rather than assumed.
TRACKER_URL = "https://tracker.example.test/x.gif"


def _headers(*, message: EmailMessage, subject: str, message_id: str) -> None:
    """Stamp the headers every fixture shares.

    Args:
        message: The message to stamp, modified in place.
        subject: The Subject header value.
        message_id: The Message-ID header value, including angle brackets.

    Returns:
        None.
    """
    message["Subject"] = subject
    message["From"] = "ops@example-counterparty.test"
    message["To"] = "recon@example-agent.test"
    message["Date"] = "Tue, 02 Sep 2026 09:15:00 +0000"
    message["Message-ID"] = message_id


def simple_eml(*, subject: str = "Fee query", body: str = "Please confirm.") -> bytes:
    """Build a single-part text/plain email.

    Args:
        subject: The Subject header value.
        body: The text/plain body.

    Returns:
        The RFC 5322 bytes of the message.
    """
    msg = EmailMessage()
    _headers(message=msg, subject=subject, message_id="<fixture-simple@example.test>")
    msg.set_content(body)
    return msg.as_bytes()


def alternative_eml(*, drop_plain: bool = False) -> bytes:
    """Build a multipart/alternative email carrying both a plain and an HTML body.

    Args:
        drop_plain: When True, emit the HTML body only. That is the unusable case -- the one
            body this system is willing to read does not exist -- and the parser must refuse
            it rather than fall back to the HTML.

    Returns:
        The RFC 5322 bytes of the message.
    """
    msg = EmailMessage()
    _headers(message=msg, subject="Fee query", message_id="<fixture-alt@example.test>")
    html = f"<p>HTML BODY <img src='{TRACKER_URL}'></p>"
    if drop_plain:
        msg.set_content(html, subtype="html")
        return msg.as_bytes()
    msg.set_content("PLAIN BODY")
    msg.add_alternative(html, subtype="html")
    return msg.as_bytes()


def with_attachment_eml(*, attachment_name: str = "notice.pdf", attachment_count: int = 1) -> bytes:
    """Build a text/plain email with one or more attachments.

    Args:
        attachment_name: The declared filename of the attachment. Used to drive the
            refused-extension case.
        attachment_count: How many attachments to add. Above one, the name is suffixed with
            an index so the filenames stay distinct; used to drive the count-limit case.

    Returns:
        The RFC 5322 bytes of the message.
    """
    msg = EmailMessage()
    _headers(message=msg, subject="Fee query", message_id="<fixture-attach@example.test>")
    msg.set_content("Please confirm.")
    stem, _, extension = attachment_name.rpartition(".")
    for index in range(attachment_count):
        name = attachment_name if attachment_count == 1 else f"{stem}-{index}.{extension}"
        msg.add_attachment(
            b"%PDF-1.4 fixture",
            maintype="application",
            subtype="pdf",
            filename=name,
        )
    return msg.as_bytes()


def nested_eml() -> bytes:
    """Build an email carrying another email as a message/rfc822 attachment.

    This is the forwarded-notice shape, and the input the recursion limit exists for.

    Returns:
        The RFC 5322 bytes of the outer message.
    """
    msg = EmailMessage()
    _headers(message=msg, subject="Fee query", message_id="<fixture-nested@example.test>")
    msg.set_content("Forwarding the notice below.")
    # Parsed back into a message object rather than attached as bytes: add_attachment routes an
    # EmailMessage through the content manager that sets message/rfc822, which is the structure
    # a real forward has. Attaching the bytes would produce an application/octet-stream blob.
    inner = email.message_from_bytes(simple_eml(subject="Inner"), policy=email.policy.default)
    msg.add_attachment(inner)
    return msg.as_bytes()
