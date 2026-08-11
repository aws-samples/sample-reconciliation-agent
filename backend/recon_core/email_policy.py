"""Counterparty-email policy: recipient allowlisting, draft construction, provenance matching.

This module is the AUTHORITATIVE implementation of the counterparty-email controls. The BFF has a
TypeScript mirror of the address check (``chatbot-app/frontend/src/lib/emailPolicy.ts``) used purely
for inline form feedback; it is deliberately NOT a security boundary, because the gateway
interceptor — which imports this module — sits on the send path and fails closed. Keeping one
authority means a drift between the two is a UX bug rather than a bypass.

Three responsibilities, all consumed by the gateway interceptor and/or the two agent backends:

1. ``parse_domain_allowlist`` / ``is_recipient_allowed`` — which addresses may receive a
   counterparty email at all. Items being reconciled arrive via IDP from documents an outside party
   sent, so a recipient the model proposed is attacker-influenceable; the allowlist is the operator's
   standing answer to "who is it ever legitimate to write to".
2. ``coerce_email_draft`` / ``build_persisted_draft`` — turn the model's ``email_draft`` into the map
   persisted on the case, dropping any address the model supplied.
3. ``normalize_for_match`` / ``draft_matches_message`` — the provenance check: a send is only allowed
   when the outgoing message equals the draft a human approved on that case.
"""

from __future__ import annotations

import json
import unicodedata

# Draft lifecycle. A field on the draft, NOT a CaseStatus — see schema.Proposal.proposed_email.
DRAFT_PENDING = "pending"
DRAFT_APPROVED = "approved"
DRAFT_DISCARDED = "discarded"
DRAFT_SENT = "sent"


def parse_domain_allowlist(raw: str) -> list[str]:
    """Parse the comma-separated counterparty-domain allowlist into normalized domains.

    :param raw: comma-separated domains, e.g. ``"example.com, Partner.CO.UK"``. Empty or
        whitespace-only yields an empty list, which allows NOTHING — see
        ``is_recipient_allowed``.
    :returns: lowercased, stripped domains with empty entries dropped.
    """
    return [part.strip().lower() for part in (raw or "").split(",") if part.strip()]


def is_recipient_allowed(*, address: str, allowlist: list[str]) -> bool:
    """Return whether ``address`` is a bare address in one of the allowlisted domains.

    Fails loudly by returning ``False`` for anything it cannot parse with certainty. In particular:

    * The domain match is EXACT, not a suffix match. A suffix match would let ``notevil.com``
      satisfy an allowlist entry of ``evil.com``, which is the whole attack this guard exists to
      stop.
    * An empty ``allowlist`` allows nothing. A misconfiguration must close the door — unlike
      ``auto_resolve.get_threshold``, whose fail-safe is toward MORE human review, this control's
      fail-safe direction is toward sending nothing.
    * The display-name form (``Foo <a@b.com>``) is rejected. The interceptor compares the raw
      address it finds in the Graph payload, so accepting a decorated form here would mean the two
      layers disagree about what the recipient is.

    :param address: the candidate recipient address.
    :param allowlist: normalized domains from ``parse_domain_allowlist``.
    :returns: ``True`` only when the address is well-formed and its domain is allowlisted.
    """
    if not allowlist:
        return False
    candidate = (address or "").strip().lower()
    # Reject anything with framing/whitespace/quoting rather than trying to unwrap it.
    if not candidate or any(ch in candidate for ch in " \t\r\n<>,;\"'"):
        return False
    if candidate.count("@") != 1:
        return False
    local, _, domain = candidate.partition("@")
    if not local or not domain or "." not in domain:
        return False
    return domain in allowlist


def coerce_email_draft(raw: object) -> dict | None:
    """Normalize the model's ``email_draft`` field into a dict, decoding a JSON-object string.

    Neither backend gets its ``email_draft`` from a schema-validated source. The harness does not
    enforce the inline-function argument schema (the same gap ``intake._coerce_evidence`` exists to
    close), and the runtime parses the model's final message as free JSON. Observed live on the
    harness backend (2026-08-09): the model emitted the nested object as a STRING —
    ``'{"recipient_hint": "...", "subject": "...", "body": "..."}'`` — so the ``isinstance(_, dict)``
    guard dropped every draft and the harness never produced one while the runtime did.
    ``email_draft`` is the first nested-object property in ``SUBMIT_PROPOSAL_SCHEMA``, which is why
    no earlier field surfaced this.

    Decoding is deliberately narrow: only a string that is already framed as a JSON object is
    parsed. Anything else stays ``None`` so the caller reports it, because a draft this function
    cannot recognize with certainty must not become a message a human is asked to approve.

    :param raw: the model's ``email_draft`` value, any shape.
    :returns: the draft as a dict, or ``None`` when it is absent, empty, or not recoverable — the
        caller decides how to report that (both call sites warn and drop).
    """
    if isinstance(raw, dict):
        return raw or None
    if isinstance(raw, str):
        stripped = raw.strip()
        # Frame check first: a bare sentence must not reach json.loads, whose error would then be
        # the reported cause rather than "the model wrote prose where an object belongs".
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                return None
            if isinstance(parsed, dict):
                return parsed or None
    return None


def build_persisted_draft(*, email_draft: dict) -> dict:
    """Convert the model's ``email_draft`` into the map persisted as ``case.proposed_email``.

    Shared by both agent backends (the Strands runtime and the harness intake) so the two cannot
    persist divergent shapes — a divergence would surface only as an interceptor denial at send
    time, on whichever backend happened to run.

    The model's address, if it supplied one, is DISCARDED: ``recipient`` is always ``None`` here and
    is filled in later by an analyst through the BFF, which re-validates it against the allowlist.
    ``recipient_hint`` (the counterparty name the model believes it is writing to) is retained for
    display only.

    :param email_draft: the model's block, requiring ``subject`` and ``body``; ``recipient_hint`` is
        optional and defaults to an empty string.
    :returns: the persisted draft map at ``revision`` 0 and ``draft_status`` ``pending``.
    :raises ValueError: when ``subject`` or ``body`` is missing or blank. Persisting half a draft
        would put a case into a state where the UI offers an approve button for text that does not
        exist.
    """
    subject = str(email_draft.get("subject") or "").strip()
    body = str(email_draft.get("body") or "").strip()
    missing = [name for name, value in (("subject", subject), ("body", body)) if not value]
    if missing:
        raise ValueError(f"email_draft is missing required field(s): {', '.join(missing)}")
    return {
        # Resolved by a human, never by the model.
        "recipient": None,
        "recipient_hint": str(email_draft.get("recipient_hint") or "").strip(),
        "subject": subject,
        "body": body,
        "draft_status": DRAFT_PENDING,
        "revision": 0,
        # Set when an analyst approves, and compared against `revision` at send time so an edit
        # landing between approval and send cannot inherit the earlier approval.
        "approved_revision": None,
        # Who did what, kept on the draft itself. The audit table's `status` column holds CaseStatus
        # values and none of these actions transitions the case, so putting them there would either
        # lie about the case's status or invent a second vocabulary for that column.
        "edited_by": None,
        "edited_at": None,
        "approved_by": None,
        "approved_at": None,
        "discarded_by": None,
        "discarded_at": None,
        "send_attempted_at": None,
        "sent_at": None,
    }


def normalize_for_match(text: str) -> str:
    """Normalize text for the provenance comparison: NFC only, no whitespace collapsing.

    Nothing transforms the message between the row the BFF reads and the arguments it sends — it is
    a single request — so tolerance buys nothing here and costs real discrimination: collapsing
    whitespace would make ``Pay $100`` and ``Pay $1 00`` compare equal. NFC IS applied, because a
    composed vs decomposed accent is a difference in representation rather than in content, and the
    two can arrive from different layers of the stack.

    :param text: the subject, body, or recipient to normalize.
    :returns: the NFC-normalized string (``None``/missing becomes empty).
    """
    return unicodedata.normalize("NFC", str(text or ""))


def draft_matches_message(*, draft: dict, recipient: str, subject: str, body: str) -> str | None:
    """Check that an outgoing counterparty message is the draft a human approved on this case.

    This is the provenance guard that upgrades the email send from a CAPABILITY check ("does the
    caller hold the confirmation token?") to the same guarantee the ledger write already has. A
    fully compromised caller holding the token can then still only send text an analyst read and
    approved.

    :param draft: the case's persisted ``proposed_email``.
    :param recipient: the sole recipient address from the Graph payload.
    :param subject: the subject from the Graph payload.
    :param body: the body content from the Graph payload.
    :returns: ``None`` when the message is authorized, else a short human-readable reason. Returning
        the reason rather than a bare bool lets the interceptor put it in the denial the caller sees.
    """
    if not draft:
        return "no email draft persisted on this case"
    status = draft.get("draft_status")
    if status != DRAFT_APPROVED:
        return f"draft is {status or 'missing'}, not approved"
    # An edit resets draft_status to pending and bumps `revision`, so a mismatch here means the
    # approval was recorded against text that has since changed.
    if draft.get("approved_revision") != draft.get("revision"):
        return (
            f"draft revision moved since approval "
            f"(approved {draft.get('approved_revision')}, current {draft.get('revision')})"
        )
    for field, sent, stored in (
        ("recipient", recipient, draft.get("recipient")),
        ("subject", subject, draft.get("subject")),
        ("body", body, draft.get("body")),
    ):
        if normalize_for_match(sent) != normalize_for_match(stored):
            return f"{field} does not match the approved draft"
    return None
