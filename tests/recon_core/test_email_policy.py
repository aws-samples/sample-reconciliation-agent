"""Counterparty-email policy: allowlisting, draft construction, provenance matching."""

import pytest

from backend.recon_core import email_policy as ep


# --- parse_domain_allowlist ------------------------------------------------------------------


def test_parse_domain_allowlist_normalizes_and_drops_blanks():
    assert ep.parse_domain_allowlist(" Example.COM , partner.co.uk ,, ") == [
        "example.com",
        "partner.co.uk",
    ]


@pytest.mark.parametrize("raw", ["", "   ", ",", ",,,"])
def test_parse_domain_allowlist_yields_nothing_for_empty_input(raw):
    assert ep.parse_domain_allowlist(raw) == []


# --- is_recipient_allowed ------------------------------------------------------------------


ALLOWED = ["example.com", "partner.co.uk"]


def test_allows_an_exact_domain_match():
    assert ep.is_recipient_allowed(address="ap@example.com", allowlist=ALLOWED) is True


def test_match_is_case_insensitive():
    assert ep.is_recipient_allowed(address="AP@Example.COM", allowlist=ALLOWED) is True


def test_surrounding_whitespace_is_tolerated():
    assert ep.is_recipient_allowed(address="  ap@example.com  ", allowlist=ALLOWED) is True


def test_domain_match_is_exact_not_a_suffix():
    """The attack the allowlist exists to stop: a lookalike domain ENDING in an allowed one."""
    assert ep.is_recipient_allowed(address="ap@notexample.com", allowlist=ALLOWED) is False
    assert ep.is_recipient_allowed(address="ap@evil-example.com", allowlist=ALLOWED) is False


def test_subdomains_are_not_allowed_implicitly():
    assert ep.is_recipient_allowed(address="ap@mail.example.com", allowlist=ALLOWED) is False


def test_an_empty_allowlist_allows_nothing():
    """Misconfiguration must close the door, not open it."""
    assert ep.is_recipient_allowed(address="ap@example.com", allowlist=[]) is False


@pytest.mark.parametrize(
    "address",
    [
        "",
        "   ",
        "ap",  # no @
        "ap@",  # no domain
        "@example.com",  # no local part
        "a@b@example.com",  # two @
        "ap@example",  # domain has no dot
        "Foo <ap@example.com>",  # display-name form: the interceptor compares raw addresses
        "ap@example.com, evil@attacker.com",  # smuggled second recipient
        "ap@example.com;evil@attacker.com",
        "ap@example.com\nBcc: evil@attacker.com",  # header injection
    ],
)
def test_rejects_anything_it_cannot_parse_with_certainty(address):
    assert ep.is_recipient_allowed(address=address, allowlist=ALLOWED) is False


# --- coerce_email_draft ---------------------------------------------------------------------


def test_coerce_passes_a_real_object_through_unchanged():
    draft = {"subject": "s", "body": "b"}
    assert ep.coerce_email_draft(draft) is draft


def test_coerce_decodes_the_json_string_the_harness_model_emits():
    """Live regression (2026-08-09): the harness does not enforce the argument schema, and the model
    emitted this nested object as a string, so every harness draft was silently dropped."""
    assert ep.coerce_email_draft('{"subject": "Wire ref", "body": "Please confirm."}') == {
        "subject": "Wire ref",
        "body": "Please confirm.",
    }
    # Leading/trailing whitespace around the object is still recoverable.
    assert ep.coerce_email_draft('  {"subject": "s", "body": "b"}  ') == {"subject": "s", "body": "b"}


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        {},
        "{}",
        "email the borrower about the wire",  # prose where an object belongs
        '{"subject": "Wire", "body": "Please conf',  # truncated: unparseable
        '{"subject": "Wire", "body": }',  # object-framed but malformed JSON
        '["subject", "body"]',  # a JSON ARRAY is not a draft
        '"just a quoted string"',
        42,
        ["subject", "body"],
    ],
)
def test_coerce_returns_none_for_anything_it_cannot_recognize_with_certainty(raw):
    """The decode is deliberately narrow. A draft this cannot read with certainty must not become a
    message a human is asked to approve — the caller warns and drops instead."""
    assert ep.coerce_email_draft(raw) is None


# --- build_persisted_draft ------------------------------------------------------------------


def test_build_persisted_draft_starts_pending_at_revision_zero():
    draft = ep.build_persisted_draft(
        email_draft={"recipient_hint": "ACME INC.", "subject": "Wire ref", "body": "Please confirm."}
    )
    assert draft["draft_status"] == ep.DRAFT_PENDING
    assert draft["revision"] == 0
    assert draft["approved_revision"] is None
    assert draft["subject"] == "Wire ref"
    assert draft["body"] == "Please confirm."
    assert draft["recipient_hint"] == "ACME INC."
    assert draft["sent_at"] is None
    assert draft["send_attempted_at"] is None


def test_build_persisted_draft_discards_any_model_supplied_address():
    """The model never picks the recipient — that is the injection path the design closes."""
    draft = ep.build_persisted_draft(
        email_draft={
            "recipient": "attacker@evil.com",
            "recipient_hint": "ACME INC.",
            "subject": "s",
            "body": "b",
        }
    )
    assert draft["recipient"] is None


def test_build_persisted_draft_tolerates_a_missing_hint():
    draft = ep.build_persisted_draft(email_draft={"subject": "s", "body": "b"})
    assert draft["recipient_hint"] == ""


@pytest.mark.parametrize(
    "email_draft, expected",
    [
        ({"body": "b"}, "subject"),
        ({"subject": "s"}, "body"),
        ({"subject": "  ", "body": "b"}, "subject"),
        ({}, "subject, body"),
    ],
)
def test_build_persisted_draft_raises_on_a_half_draft(email_draft, expected):
    with pytest.raises(ValueError, match=expected):
        ep.build_persisted_draft(email_draft=email_draft)


# --- normalize_for_match ------------------------------------------------------------------


def test_normalize_applies_nfc():
    # Written as escapes on purpose: the two forms are visually identical, so source literals would
    # make this test silently vacuous.
    decomposed = "cafe\u0301"  # e + COMBINING ACUTE ACCENT
    composed = "caf\u00e9"  # LATIN SMALL LETTER E WITH ACUTE
    assert decomposed != composed  # guard: they really are different inputs
    assert ep.normalize_for_match(decomposed) == ep.normalize_for_match(composed)


def test_normalize_does_not_collapse_whitespace():
    """Collapsing would make 'Pay $100' and 'Pay $1 00' compare equal."""
    assert ep.normalize_for_match("Pay $100") != ep.normalize_for_match("Pay $1 00")
    assert ep.normalize_for_match("a  b") != ep.normalize_for_match("a b")


# --- draft_matches_message ------------------------------------------------------------------


def _approved_draft(**overrides) -> dict:
    draft = {
        "recipient": "ap@example.com",
        "subject": "Wire ref",
        "body": "Please confirm.",
        "draft_status": ep.DRAFT_APPROVED,
        "revision": 2,
        "approved_revision": 2,
    }
    draft.update(overrides)
    return draft


def _match(draft, **overrides):
    args = {"recipient": "ap@example.com", "subject": "Wire ref", "body": "Please confirm."}
    args.update(overrides)
    return ep.draft_matches_message(draft=draft, **args)


def test_an_exact_match_on_an_approved_draft_is_authorized():
    assert _match(_approved_draft()) is None


@pytest.mark.parametrize("field", ["recipient", "subject", "body"])
def test_a_one_character_difference_is_denied(field):
    reason = _match(_approved_draft(), **{field: "x" + _approved_draft()[field]})
    assert reason is not None and field in reason


def test_a_pending_draft_is_denied():
    reason = _match(_approved_draft(draft_status=ep.DRAFT_PENDING))
    assert reason is not None and "not approved" in reason


@pytest.mark.parametrize("status", [ep.DRAFT_DISCARDED, ep.DRAFT_SENT, None, ""])
def test_only_approved_drafts_may_send(status):
    assert _match(_approved_draft(draft_status=status)) is not None


def test_no_draft_at_all_is_denied():
    for empty in (None, {}):
        reason = ep.draft_matches_message(draft=empty, recipient="a@b.com", subject="s", body="b")
        assert reason is not None and "no email draft" in reason


def test_an_edit_after_approval_is_denied_even_when_the_text_matches():
    """Revision pinning: provenance alone cannot tell that the approval predates the current text.

    Approve-draft and case-approve are two requests. Both read the same row, so a comparison against
    the CURRENT draft always passes — the approval would silently transfer to text nobody read.
    """
    draft = _approved_draft(revision=3, approved_revision=2)
    reason = ep.draft_matches_message(
        draft=draft, recipient=draft["recipient"], subject=draft["subject"], body=draft["body"]
    )
    assert reason is not None and "revision moved" in reason


def test_a_never_approved_revision_is_denied():
    assert _match(_approved_draft(approved_revision=None)) is not None


def test_nfc_differences_do_not_block_a_legitimate_send():
    """NFC is the one tolerance kept: representation may differ between layers, content may not."""
    draft = _approved_draft(body="caf\u00e9 receipt")
    assert _match(draft, body="cafe\u0301 receipt") is None
