"""Renders an email body as a PDF.

The body arrives as plain text and has to leave as a document, because the document
pipeline's configuration accepts PDF and DOCX -- a `.txt` upload is simply rejected. PDF also
works for the knowledge-base connector, so one format covers both destinations.

This uses reportlab's platypus layer rather than the low-level canvas so that a body longer
than a page flows onto the next one instead of being clipped. Every line of body text is
escaped and emitted as a separate paragraph: the input is counterparty-supplied, and
platypus paragraphs accept a small HTML-like markup, so an unescaped `<` in a body could
otherwise change the document's structure or raise a parse error mid-render.
"""

from __future__ import annotations

import io
from xml.sax.saxutils import escape

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


def render_body_pdf(*, subject: str, sender: str, body: str) -> bytes:
    """Render an email body to a PDF.

    Args:
        subject: The email's subject, rendered as the document heading.
        sender: The From address, rendered under the heading so the extracted document
            still records who sent it.
        body: The text/plain body.

    Returns:
        The PDF bytes.

    Raises:
        ValueError: The body is empty or whitespace only.
    """
    if not body.strip():
        raise ValueError("cannot render an empty email body")

    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        title=subject or "(no subject)",
        author=sender or "(unknown sender)",
    )
    styles = getSampleStyleSheet()
    # A fixed-width font keeps any table a sender pasted into the body roughly aligned, which
    # matters because the extraction model reads this rendering, not the original.
    body_style = ParagraphStyle(
        "EmailBody", parent=styles["BodyText"], fontName="Courier", fontSize=9, leading=11
    )

    flow: list[object] = [
        Paragraph(escape(subject or "(no subject)"), styles["Heading2"]),
        Paragraph(escape(f"From: {sender or '(unknown sender)'}"), styles["Italic"]),
        Spacer(1, 12),
    ]
    for line in body.splitlines():
        # A blank line becomes vertical space rather than an empty paragraph, which platypus
        # collapses to nothing -- losing the paragraph breaks the sender wrote.
        flow.append(Spacer(1, 8) if not line.strip() else Paragraph(escape(line), body_style))

    document.build(flow)
    return buffer.getvalue()
