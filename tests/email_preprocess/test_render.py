"""Tests for the body-to-PDF renderer."""

import pytest

from backend.email_preprocess.render import render_body_pdf


def test_renders_a_pdf() -> None:
    pdf = render_body_pdf(subject="Fee query", sender="ops@example.test", body="Please confirm.")
    # The magic bytes are the only structural assertion worth making. Asserting on the
    # extracted text would test reportlab, and asserting on exact bytes would break on any
    # reportlab upgrade -- PDFs embed a creation timestamp.
    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 500


def test_long_body_produces_more_than_one_page() -> None:
    pdf = render_body_pdf(subject="s", sender="a@b.test", body="line\n" * 4000)
    assert pdf.count(b"/Type /Page") > 1


def test_empty_body_is_refused() -> None:
    # An empty body means the split found a text/plain part with nothing in it. Rendering a
    # blank page would put a document with no content into the corpus, which is worse than
    # telling the operator the email had no body.
    with pytest.raises(ValueError, match="empty"):
        render_body_pdf(subject="s", sender="a@b.test", body="   \n  ")
