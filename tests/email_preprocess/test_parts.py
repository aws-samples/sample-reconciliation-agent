"""Tests for the pure email-splitting layer."""

import pytest

from backend.email_preprocess.parts import (
    PartKind,
    UnsupportedEmail,
    _split_parsed_msg,
    split_email,
    split_upload,
)
from tests.email_preprocess.fixtures.build_fixtures import (
    alternative_eml,
    nested_eml,
    simple_eml,
    with_attachment_eml,
)


def test_single_part_email_yields_one_body() -> None:
    parts = split_email(raw=simple_eml(), filename="q.eml", depth=0)
    assert [p.kind for p in parts] == [PartKind.BODY]
    assert parts[0].subject == "Fee query"
    assert "Please confirm." in parts[0].text
    assert parts[0].sender == "ops@example-counterparty.test"


def test_multipart_alternative_reads_plain_and_never_html() -> None:
    parts = split_email(raw=alternative_eml(), filename="q.eml", depth=0)
    body = parts[0].text
    assert "PLAIN BODY" in body
    # The whole reason this layer exists. If the HTML part were ever read, the tracker URL
    # would appear here -- and a renderer that fetches it turns a counterparty email into an
    # outbound request from inside the VPC and a read receipt for the sender.
    assert "tracker.example.test" not in body
    assert "HTML BODY" not in body


def test_attachment_becomes_its_own_part() -> None:
    parts = split_email(raw=with_attachment_eml(), filename="q.eml", depth=0)
    assert [p.kind for p in parts] == [PartKind.BODY, PartKind.ATTACHMENT]
    attached = parts[1]
    assert attached.filename == "notice.pdf"
    assert attached.content == b"%PDF-1.4 fixture"
    assert attached.extension == ".pdf"


def test_nested_message_recurses_exactly_once() -> None:
    parts = split_email(raw=nested_eml(), filename="q.eml", depth=0)
    subjects = [p.subject for p in parts]
    assert "Fee query" in subjects
    assert "Inner" in subjects


def test_nested_message_at_the_depth_limit_is_refused() -> None:
    # depth=1 means we are already inside one nested message, so a second one stops here.
    with pytest.raises(UnsupportedEmail, match="nesting depth"):
        split_email(raw=nested_eml(), filename="q.eml", depth=1)


def test_attachment_with_an_unsupported_extension_is_refused() -> None:
    msg_bytes = with_attachment_eml(attachment_name="macro.docm")
    with pytest.raises(UnsupportedEmail, match="macro.docm"):
        split_email(raw=msg_bytes, filename="q.eml", depth=0)


def test_too_many_attachments_is_refused() -> None:
    raw = with_attachment_eml(attachment_count=26)
    with pytest.raises(UnsupportedEmail, match="attachment count"):
        split_email(raw=raw, filename="q.eml", depth=0)


def test_email_with_no_text_body_is_refused() -> None:
    # An HTML-only email is genuinely unusable here: the only body we are willing to read
    # does not exist. Refusing tells the operator to ask for a PDF, which is far better
    # than silently uploading an empty document.
    raw = alternative_eml(drop_plain=True)
    with pytest.raises(UnsupportedEmail, match="no text/plain"):
        split_email(raw=raw, filename="q.eml", depth=0)


class _StubAttachment:
    """Stands in for an extract_msg attachment: just the two fields the mapping reads."""

    def __init__(self, *, name: str, data: bytes) -> None:
        self.longFilename = name
        self.data = data


class _StubMsg:
    """Stands in for extract_msg.Message, exposing only what the mapping reads."""

    def __init__(self, *, attachments: list[_StubAttachment] | None = None) -> None:
        self.subject = "Fee query"
        self.sender = "ops@example-counterparty.test"
        self.to = "recon@example-agent.test"
        self.messageId = "<fixture-msg@example.test>"
        self.date = "Tue, 02 Sep 2026 09:15:00 +0000"
        self.body = "Please confirm."
        self.attachments = attachments or []


def test_outlook_message_maps_onto_the_shared_splitter() -> None:
    parts = _split_parsed_msg(parsed=_StubMsg(), filename="q.msg")
    assert [p.kind for p in parts] == [PartKind.BODY]
    assert parts[0].subject == "Fee query"
    assert parts[0].sender == "ops@example-counterparty.test"
    assert "Please confirm." in parts[0].text


def test_outlook_attachment_bounds_are_the_shared_ones() -> None:
    # The point of this test is that the .msg path did not grow its own copy of the rules.
    stub = _StubMsg(attachments=[_StubAttachment(name="macro.docm", data=b"x")])
    with pytest.raises(UnsupportedEmail, match="macro.docm"):
        _split_parsed_msg(parsed=stub, filename="q.msg")


def test_outlook_message_with_no_body_is_refused() -> None:
    stub = _StubMsg()
    stub.body = None
    with pytest.raises(UnsupportedEmail, match="no text/plain"):
        _split_parsed_msg(parsed=stub, filename="q.msg")


def test_dispatch_refuses_a_type_it_does_not_handle() -> None:
    with pytest.raises(UnsupportedEmail, match=r"\.pdf"):
        split_upload(raw=b"%PDF-1.4", filename="notice.pdf")
