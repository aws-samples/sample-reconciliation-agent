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
   persisted on the case. The model cites a ``recipient_contact_id`` and a ``template_id``; it never
   supplies an address, and one appearing in its payload is refused rather than dropped.
3. ``normalize_for_match`` / ``draft_matches_message`` — the provenance check: a send is only allowed
   when the outgoing message equals the draft a human approved on that case. The recipient half of
   that comparison is an address the CALLER resolved from the draft's contact id, because the
   persisted draft deliberately holds none.
"""

from __future__ import annotations

import json
import os
import unicodedata

from backend.recon_core.templating import render_template

# Draft lifecycle. A field on the draft, NOT a CaseStatus — see schema.Proposal.proposed_email.
DRAFT_PENDING = "pending"
DRAFT_APPROVED = "approved"
DRAFT_DISCARDED = "discarded"
DRAFT_SENT = "sent"
# The template the operator wrote could not be rendered with the values the model supplied. The draft
# is persisted anyway, visibly broken, with no approve button — see build_persisted_draft.
DRAFT_RENDER_FAILED = "render_failed"

# Named because the interceptor needs the same wording BEFORE it resolves the draft's contact id: on a
# case with no draft at all there is no id to resolve, and reporting the missing id would describe "the
# approved draft" on a case that has none. One constant keeps the two callers from drifting.
NO_DRAFT_REASON = "no email draft persisted on this case"


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
    close), and the runtime parses the model's final message as free JSON. The model does emit this
    nested object as a STRING — ``'{"recipient_hint": "...", "subject": "...", "body": "..."}'`` —
    and a bare ``isinstance(_, dict)`` guard drops every such draft, so the harness produces none
    while the runtime does. ``email_draft`` is the first nested-object property in
    ``SUBMIT_PROPOSAL_SCHEMA``, so it is the first field where the shape can diverge at all.

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


def _template_store():
    """Construct the live TemplateStore from the environment.

    Imported inside the function rather than at module scope: ``backend.contacts.store`` imports
    ``backend.recon_core.templating``, so a top-level import here would make the two packages depend
    on each other in both directions. The seam also keeps the interceptor — which imports this module
    on every gateway call — from touching the templates table at import time.

    :returns: a TemplateStore bound to ``TEMPLATES_TABLE``.
    :raises KeyError: when ``TEMPLATES_TABLE`` is unset; a default would render against a table named
        ``""`` and report every template as missing.
    """
    from backend.contacts.store import TemplateStore

    return TemplateStore(table=os.environ["TEMPLATES_TABLE"])


def build_persisted_draft(*, email_draft: dict, templates=None) -> dict:
    """Convert the model's ``email_draft`` into the map persisted as ``case.proposed_email``.

    Shared by both agent backends (the Strands runtime and the harness intake) so the two cannot
    persist divergent shapes — a divergence would surface only as an interceptor denial at send
    time, on whichever backend happened to run.

    The model never supplies an address and never supplies message text. It cites a
    ``recipient_contact_id`` and a ``template_id`` plus ``variables``; the operator owns both the
    recipient list and the wording. ``recipient`` stays ``None`` in the persisted row forever — the
    address is resolved server-side at send time, twice and independently, by the BFF (to know where
    to send) and by the interceptor (to decide whether to allow). ``recipient_hint`` (the counterparty
    name the model believes it is writing to) is retained for display and cross-checked against the
    contact's ``display_name`` on the case screen.

    The template is rendered HERE, before the analyst ever sees the draft, and the rendered strings are
    what get persisted. The ordering is mandatory rather than convenient: ``draft_matches_message``
    compares the approved bytes against the outgoing bytes, so rendering after approval would fail
    byte-identity on every single send.

    A render failure is persisted, not raised. Both call sites wrap this function in
    ``except ValueError`` and discard the draft, so a raise would reach nobody who can act on it and
    the analyst would see a case with no email — indistinguishable from a case that legitimately
    needed none. Instead the draft lands with ``draft_status = "render_failed"`` and a ``render_error``
    naming the cause, which the operator who can fix the template will actually find.

    :param email_draft: the model's block, requiring ``recipient_contact_id`` and ``template_id``.
        ``variables`` is a name → value map for the template's declared placeholders;
        ``recipient_hint`` is optional.
    :param templates: injectable TemplateStore stand-in (tests); the live store by default.
    :returns: the persisted draft map at ``revision`` 0, ``draft_status`` ``pending`` when the render
        succeeded and ``render_failed`` when it did not.
    :raises ValueError: when ``recipient_contact_id`` or ``template_id`` is missing, or when the model
        supplied a literal ``recipient``. The first two mean the model did not produce a draft at all,
        which is the same class as today's missing subject/body; the third is refused rather than
        dropped so a model that learns to emit an address gets a hard error instead of quietly having
        it ignored.
    """
    if str(email_draft.get("recipient") or "").strip():
        raise ValueError(
            "email_draft carries a literal recipient address; drafts must cite a "
            "recipient_contact_id instead"
        )
    contact_id = str(email_draft.get("recipient_contact_id") or "").strip()
    template_id = str(email_draft.get("template_id") or "").strip()
    missing = [
        name
        for name, value in (("recipient_contact_id", contact_id), ("template_id", template_id))
        if not value
    ]
    if missing:
        raise ValueError(f"email_draft is missing required field(s): {', '.join(missing)}")

    raw_variables = email_draft.get("variables")
    variables = (
        {str(k): str(v) for k, v in raw_variables.items()}
        if isinstance(raw_variables, dict)
        else {}
    )

    subject = ""
    body = ""
    render_error: str | None = None
    try:
        template = (templates or _template_store()).get(template_id=template_id)
        declared = [str(v) for v in (template.get("variables") or [])]
        subject = render_template(
            template=str(template.get("subject_template") or ""),
            declared=declared,
            values=variables,
        )
        body = render_template(
            template=str(template.get("body_template") or ""),
            declared=declared,
            values=variables,
        )
    except (LookupError, ValueError) as exc:
        # LookupError: the template was deleted or deactivated between the agent reading the list and
        # submitting. ValueError: its declared variables and the model's payload disagree. Both are
        # operator-fixable and both must be visible on the case.
        render_error = f"{type(exc).__name__}: {exc}"

    return {
        # Resolved server-side at send time, never stored. See the docstring.
        "recipient": None,
        "recipient_contact_id": contact_id,
        "recipient_hint": str(email_draft.get("recipient_hint") or "").strip(),
        "template_id": template_id,
        "variables": variables,
        "subject": subject,
        "body": body,
        "draft_status": DRAFT_PENDING if render_error is None else DRAFT_RENDER_FAILED,
        # None on the happy path. Non-None is what the case screen keys off to show the amber state
        # and withhold the approve button.
        "render_error": render_error,
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


def draft_matches_message(
    *, draft: dict, recipient: str, subject: str, body: str, resolved_recipient: str
) -> str | None:
    """Check that an outgoing counterparty message is the draft a human approved on this case.

    This is the provenance guard that upgrades the email send from a CAPABILITY check ("does the
    caller hold the confirmation token?") to the same guarantee the ledger write already has. A
    fully compromised caller holding the token can then still only send text an analyst read and
    approved.

    The recipient is compared against ``resolved_recipient``, NOT against ``draft["recipient"]``. The
    persisted draft holds no address at all by design, so ``draft["recipient"]`` is always ``None`` and
    comparing against it would deny every send with "recipient does not match the approved draft" — a
    message naming the address, which reads like a domain-allowlist problem and sends the reader to the
    wrong control entirely. The caller passes the address it resolved itself from the draft's
    ``recipient_contact_id``, on this call, out of the operator's table. So the comparison trusts
    neither the address the caller supplied nor any stored one.

    :param draft: the case's persisted ``proposed_email``.
    :param recipient: the sole recipient address from the Graph payload — the value under test.
    :param subject: the subject from the Graph payload.
    :param body: the body content from the Graph payload.
    :param resolved_recipient: the address the caller resolved from the draft's contact id. Required,
        with no default: a default would let a new call site silently compare against nothing.
    :returns: ``None`` when the message is authorized, else a short human-readable reason. Returning
        the reason rather than a bare bool lets the interceptor put it in the denial the caller sees.
    """
    if not draft:
        return NO_DRAFT_REASON
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
        ("recipient", recipient, resolved_recipient),
        ("subject", subject, draft.get("subject")),
        ("body", body, draft.get("body")),
    ):
        if normalize_for_match(sent) != normalize_for_match(stored):
            return f"{field} does not match the approved draft"
    return None
