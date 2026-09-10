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
    """Live regression: the harness does not enforce the argument schema, so the model can emit this
    nested object as a string — and without the coercion every harness draft is silently dropped."""
    assert ep.coerce_email_draft('{"subject": "Wire ref", "body": "Please confirm."}') == {
        "subject": "Wire ref",
        "body": "Please confirm.",
    }
    # Leading/trailing whitespace around the object is still recoverable.
    assert ep.coerce_email_draft('  {"subject": "s", "body": "b"}  ') == {
        "subject": "s",
        "body": "b",
    }


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


class _Templates:
    """A TemplateStore stand-in serving one canned template.

    Only ``get`` is used by ``build_persisted_draft``, so only ``get`` exists here — a fuller fake
    would invite tests to assert against behaviour the real store owns and this one only mimics.
    """

    def __init__(self, *, row: dict | None = None, missing: bool = False) -> None:
        """Serve ``row`` for any template_id, or refuse every lookup.

        :param row: the template row to return; a wire-reference template by default.
        :param missing: when True, every ``get`` raises LookupError, standing in for a template the
            operator deactivated between the agent listing it and the agent submitting.
        """
        self._row = row or {
            "template_id": "tpl-wire",
            "subject_template": "Wire ref {{invoice}}",
            "body_template": "Please confirm {{invoice}}.",
            "variables": ["invoice"],
        }
        self._missing = missing

    def get(self, *, template_id: str) -> dict:
        """Return the canned template, or raise as an absent one would.

        :param template_id: the id the draft cited; recorded but not matched.
        :returns: the canned row.
        :raises LookupError: when this stand-in was built with ``missing=True``.
        """
        if self._missing:
            raise LookupError(f"template {template_id!r} does not exist")
        return self._row


def _model_draft(**overrides) -> dict:
    """The email_draft block a well-behaved model emits: two ids and the template's variables.

    :param overrides: fields to add or replace.
    :returns: the draft block.
    """
    draft = {
        "recipient_contact_id": "cp-acme",
        "recipient_hint": "ACME INC.",
        "template_id": "tpl-wire",
        "variables": {"invoice": "INV-77"},
    }
    draft.update(overrides)
    return draft


def test_build_persisted_draft_starts_pending_at_revision_zero():
    draft = ep.build_persisted_draft(email_draft=_model_draft(), templates=_Templates())
    assert draft["draft_status"] == ep.DRAFT_PENDING
    assert draft["render_error"] is None
    assert draft["revision"] == 0
    assert draft["approved_revision"] is None
    assert draft["subject"] == "Wire ref INV-77"
    assert draft["body"] == "Please confirm INV-77."
    assert draft["recipient_hint"] == "ACME INC."
    assert draft["sent_at"] is None
    assert draft["send_attempted_at"] is None


def test_a_persisted_draft_never_holds_an_address():
    """The row carries a contact id, and the address is resolved at send time.

    An address landing in the row would be an address the model could have influenced, and it would
    then be the thing the interceptor compares against — collapsing two independent resolutions into
    one stored value that nobody re-checks.
    """
    draft = ep.build_persisted_draft(email_draft=_model_draft(), templates=_Templates())
    assert draft["recipient"] is None
    assert draft["recipient_contact_id"] == "cp-acme"
    assert "email" not in draft


def test_build_persisted_draft_refuses_a_model_supplied_address():
    """Refused, not dropped: a model that learns to emit an address must get a hard error, so the
    behaviour shows up in a log instead of being silently normalized away."""
    with pytest.raises(ValueError, match="literal recipient address"):
        ep.build_persisted_draft(
            email_draft=_model_draft(recipient="attacker@evil.com"), templates=_Templates()
        )


def test_build_persisted_draft_tolerates_a_missing_hint():
    draft = ep.build_persisted_draft(
        email_draft=_model_draft(recipient_hint=None), templates=_Templates()
    )
    assert draft["recipient_hint"] == ""


@pytest.mark.parametrize(
    "email_draft, expected",
    [
        ({"template_id": "tpl-wire"}, "recipient_contact_id"),
        ({"recipient_contact_id": "cp-acme"}, "template_id"),
        ({"recipient_contact_id": "  ", "template_id": "tpl-wire"}, "recipient_contact_id"),
        ({}, "recipient_contact_id, template_id"),
    ],
)
def test_build_persisted_draft_raises_when_either_id_is_absent(email_draft, expected):
    """No ids means the model produced no draft at all, which the callers already warn and drop on."""
    with pytest.raises(ValueError, match=expected):
        ep.build_persisted_draft(email_draft=email_draft, templates=_Templates())


def test_a_deactivated_template_persists_a_visible_failure_rather_than_raising():
    """Both call sites swallow ValueError and discard, so raising here would leave
    the analyst a case with no email — indistinguishable from one that needed none."""
    draft = ep.build_persisted_draft(email_draft=_model_draft(), templates=_Templates(missing=True))
    assert draft["draft_status"] == ep.DRAFT_RENDER_FAILED
    assert "LookupError" in draft["render_error"]
    assert "tpl-wire" in draft["render_error"]
    # The ids survive, so the operator can see which template needs fixing.
    assert draft["template_id"] == "tpl-wire"
    assert draft["recipient_contact_id"] == "cp-acme"
    assert draft["subject"] == ""
    assert draft["body"] == ""


def test_a_variable_the_template_does_not_declare_persists_a_visible_failure():
    draft = ep.build_persisted_draft(
        email_draft=_model_draft(variables={"invoice": "INV-77", "amount": "100"}),
        templates=_Templates(),
    )
    assert draft["draft_status"] == ep.DRAFT_RENDER_FAILED
    assert "amount" in draft["render_error"]


def test_a_missing_variable_value_persists_a_visible_failure():
    draft = ep.build_persisted_draft(email_draft=_model_draft(variables={}), templates=_Templates())
    assert draft["draft_status"] == ep.DRAFT_RENDER_FAILED
    assert "invoice" in draft["render_error"]


def test_variables_are_coerced_to_strings():
    """The model may emit a number; the renderer substitutes strings, and a raw int would raise
    inside re.sub with a message naming neither the template nor the variable."""
    draft = ep.build_persisted_draft(
        email_draft=_model_draft(variables={"invoice": 77}), templates=_Templates()
    )
    assert draft["subject"] == "Wire ref 77"
    assert draft["variables"] == {"invoice": "77"}


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
        # None, as every persisted draft's is. The address lives in the contacts table.
        "recipient": None,
        "recipient_contact_id": "cp-acme",
        "subject": "Wire ref",
        "body": "Please confirm.",
        "draft_status": ep.DRAFT_APPROVED,
        "revision": 2,
        "approved_revision": 2,
    }
    draft.update(overrides)
    return draft


def _match(draft, **overrides):
    args = {
        "recipient": "ap@example.com",
        "subject": "Wire ref",
        "body": "Please confirm.",
        # What the caller resolved from the draft's contact id on this call, out of the operator's
        # table. Equal to `recipient` on the happy path — the two arrive by different routes.
        "resolved_recipient": "ap@example.com",
    }
    args.update(overrides)
    return ep.draft_matches_message(draft=draft, **args)


def test_an_exact_match_on_an_approved_draft_is_authorized():
    assert _match(_approved_draft()) is None


@pytest.mark.parametrize("field", ["recipient", "subject", "body"])
def test_a_one_character_difference_is_denied(field):
    sent = {"recipient": "ap@example.com", "subject": "Wire ref", "body": "Please confirm."}
    reason = _match(_approved_draft(), **{field: "x" + sent[field]})
    assert reason is not None and field in reason


def test_draft_matches_message_compares_against_the_resolved_recipient():
    """The one test that would catch the whole counterparty path shipping broken.

    Every persisted draft holds ``recipient: None``, and ``normalize_for_match(None)`` is ``""``. A
    comparison against ``draft["recipient"]`` therefore denies EVERY counterparty send — with a reason
    naming the recipient, which points the reader at the domain allowlist, the wrong control entirely.
    """
    # The address the caller resolved is what authorizes the send, though the row itself holds none.
    assert _match(_approved_draft()) is None
    # And a send to an address that is not the one the draft's contact resolves to is denied:
    # `recipient` is the value under test, `resolved_recipient` the authority.
    reason = _match(_approved_draft(), recipient="evil@attacker.com")
    assert reason is not None and "recipient" in reason


def test_a_pending_draft_is_denied():
    reason = _match(_approved_draft(draft_status=ep.DRAFT_PENDING))
    assert reason is not None and "not approved" in reason


def test_a_render_failed_draft_is_denied():
    """It has no approve button in the UI, but the send path must not depend on that."""
    reason = _match(_approved_draft(draft_status=ep.DRAFT_RENDER_FAILED))
    assert reason is not None and "not approved" in reason


@pytest.mark.parametrize("status", [ep.DRAFT_DISCARDED, ep.DRAFT_SENT, None, ""])
def test_only_approved_drafts_may_send(status):
    assert _match(_approved_draft(draft_status=status)) is not None


def test_no_draft_at_all_is_denied():
    for empty in (None, {}):
        reason = ep.draft_matches_message(
            draft=empty,
            recipient="a@b.com",
            subject="s",
            body="b",
            resolved_recipient="a@b.com",
        )
        assert reason is not None and "no email draft" in reason


def test_an_edit_after_approval_is_denied_even_when_the_text_matches():
    """Revision pinning: provenance alone cannot tell that the approval predates the current text.

    Approve-draft and case-approve are two requests. Both read the same row, so a comparison against
    the CURRENT draft always passes — the approval would silently transfer to text nobody read.
    """
    draft = _approved_draft(revision=3, approved_revision=2)
    reason = _match(draft)
    assert reason is not None and "revision moved" in reason


def test_a_never_approved_revision_is_denied():
    assert _match(_approved_draft(approved_revision=None)) is not None


def test_nfc_differences_do_not_block_a_legitimate_send():
    """NFC is the one tolerance kept: representation may differ between layers, content may not."""
    draft = _approved_draft(body="caf\u00e9 receipt")
    assert _match(draft, body="cafe\u0301 receipt") is None
