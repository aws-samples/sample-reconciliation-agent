"""Operator-owned recipients and email templates.

One module owns both tables so that the rule "an agent-facing read never carries an email address"
lives in exactly one place. The two read shapes are deliberately different: ``list_for_agent``
projects away ``email`` entirely, and ``resolve_address`` is the only method in the codebase that
returns one. Anything that needs an address goes through that method, at send time, and gets a
``LookupError`` rather than a fallback when the contact is not sendable.

Both stores read with a ``Scan``. These tables are operator-sized — tens of rows — so a GSI would be
ceremony, and a fresh read on every call is the point rather than a cost: a cache would keep a
deactivated recipient sendable for the length of its TTL, which is the exact window deactivation
exists to close.
"""

from datetime import UTC, datetime

import boto3

from backend.recon_core.templating import placeholders_in

# The only keys an agent-facing caller ever sees. `email` is absent by construction, not by filtering
# at the call site, so a new caller cannot forget.
AGENT_CONTACT_KEYS = ("contact_id", "display_name", "kind", "active")
AGENT_TEMPLATE_KEYS = ("template_id", "name", "purpose", "variables", "active")

CONTACT_KINDS = ("counterparty", "internal_notification")
TEMPLATE_PURPOSES = CONTACT_KINDS


def _now() -> str:
    """The current UTC timestamp in the ISO-8601 form the rest of the recon tables use.

    :returns: e.g. ``2026-09-02T14:03:11``.
    """
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")


def _project(row: dict, *, keys: tuple[str, ...]) -> dict:
    """Copy only the named keys out of a stored row.

    :param row: the raw DynamoDB item.
    :param keys: the attribute names to keep.
    :returns: a new dict holding only those of ``keys`` that the row actually has.
    """
    return {k: row[k] for k in keys if k in row}


class ContactStore:
    """DynamoDB accessor for the recon-contacts table."""

    def __init__(self, *, table: str, ddb=None) -> None:
        """Bind to the named DynamoDB table.

        :param table: name of the recon-contacts table.
        :param ddb: injectable DynamoDB resource. The gateway interceptor already carries one through
            its call chain for its own reads, and ``resolve_address`` is the single place an address
            is produced — so the interceptor uses this store rather than reimplementing the three
            refusals, which would put a second, drifting answer to "may we send to this contact" on
            the send path.
        """
        self._table = (ddb or boto3.resource("dynamodb")).Table(table)

    def list_for_agent(self, *, kind: str | None = None) -> list[dict]:
        """Active contacts, projected to ``AGENT_CONTACT_KEYS``.

        Never includes ``email``. This is the shape the gateway read tool returns, so the model can
        cite a recipient without ever holding one.

        :param kind: optionally restrict to ``counterparty`` or ``internal_notification``.
        :returns: one dict per active contact, each carrying exactly ``AGENT_CONTACT_KEYS``.
        """
        rows = [r for r in self._scan() if r.get("active")]
        if kind is not None:
            rows = [r for r in rows if r.get("kind") == kind]
        return [_project(r, keys=AGENT_CONTACT_KEYS) for r in rows]

    def resolve_address(self, *, contact_id: str, kind: str) -> str:
        """The email address for one active contact of the given kind.

        :param contact_id: the id the draft or the caller cited.
        :param kind: the purpose this send is for; a contact of another kind cannot satisfy it.
        :returns: the contact's email address.
        :raises LookupError: unknown id, inactive contact, or a kind mismatch. Every one of the three
            is a refusal to send, not a fallback — an inactive contact must make an already-approved
            draft unsendable, which is what makes deactivation a revocation. The message names the
            ``contact_id`` and which of the three it was, because the two callers that catch it (the
            interceptor's blanket ``except`` and ``maybe_auto_resolve``'s best-effort wrapper) log
            only the exception, so anything absent from the message is unrecoverable.
        """
        resp = self._table.get_item(Key={"contact_id": contact_id})
        row = resp.get("Item")
        if row is None:
            raise LookupError(f"contact {contact_id!r} does not exist")
        if not row.get("active"):
            raise LookupError(f"contact {contact_id!r} is deactivated and cannot be sent to")
        if row.get("kind") != kind:
            raise LookupError(
                f"contact {contact_id!r} has kind {row.get('kind')!r}, "
                f"which cannot satisfy a {kind!r} send"
            )
        email = row.get("email")
        if not email:
            raise LookupError(f"contact {contact_id!r} has no email address stored")
        return str(email)

    def list_all(self) -> list[dict]:
        """Every contact including inactive ones AND their addresses — operator console only.

        :returns: the raw rows, addresses included.
        """
        return self._scan()

    def put(self, *, contact: dict, actor: str) -> dict:
        """Create or replace one contact, stamping the audit attributes.

        :param contact: must carry ``contact_id``, ``display_name``, ``email`` and ``kind``.
            ``active`` defaults to True on create and is preserved on update.
        :param actor: the authenticated principal making the change.
        :returns: the row as written.
        :raises ValueError: on a missing required attribute or an unknown ``kind``. Refused here
            rather than defaulted, because a contact with the wrong kind is silently unsendable.
        """
        for key in ("contact_id", "display_name", "email", "kind"):
            if not contact.get(key):
                raise ValueError(f"contact is missing {key}")
        if contact["kind"] not in CONTACT_KINDS:
            raise ValueError(
                f"contact kind {contact['kind']!r} is not one of {', '.join(CONTACT_KINDS)}"
            )
        existing = self._table.get_item(Key={"contact_id": contact["contact_id"]}).get("Item") or {}
        now = _now()
        row = {
            **contact,
            "active": bool(contact.get("active", existing.get("active", True))),
            # created_by/created_at are provenance: an edit must not rewrite who added the recipient.
            "created_by": existing.get("created_by", actor),
            "created_at": existing.get("created_at", now),
            "updated_by": actor,
            "updated_at": now,
        }
        self._table.put_item(Item=row)
        return row

    def deactivate(self, *, contact_id: str, actor: str) -> None:
        """Soft-delete one contact.

        Never a ``DeleteItem``. A hard delete would strand every historical draft citing the id, and
        the case screen would render a blank recipient with no way to tell whether it was never set
        or later removed.

        :param contact_id: the contact to deactivate.
        :param actor: the authenticated principal making the change.
        :returns: None.
        :raises LookupError: if no such contact exists — deactivating nothing must not read as
            success.
        """
        existing = self._table.get_item(Key={"contact_id": contact_id}).get("Item")
        if existing is None:
            raise LookupError(f"contact {contact_id!r} does not exist")
        self._table.put_item(
            Item={**existing, "active": False, "updated_by": actor, "updated_at": _now()}
        )

    def _scan(self) -> list[dict]:
        """Every row in the table, following pagination.

        :returns: the raw items.
        """
        return _scan_all(table=self._table)


class TemplateStore:
    """DynamoDB accessor for the recon-email-templates table."""

    def __init__(self, *, table: str, ddb=None) -> None:
        """Bind to the named DynamoDB table.

        :param table: name of the recon-email-templates table.
        :param ddb: injectable DynamoDB resource; the default session's otherwise.
        """
        self._table = (ddb or boto3.resource("dynamodb")).Table(table)

    def list_for_agent(self, *, purpose: str | None = None) -> list[dict]:
        """Active templates, projected to ``AGENT_TEMPLATE_KEYS``.

        The bodies are withheld on purpose: the agent picks a ``template_id`` and supplies values for
        the declared ``variables``. Returning the bytes invites the model to paste a mutated copy,
        which would then fail the platform's own render-and-compare.

        :param purpose: optionally restrict to ``counterparty`` or ``internal_notification``.
        :returns: one dict per active template, each carrying exactly ``AGENT_TEMPLATE_KEYS``.
        """
        rows = [r for r in self._scan() if r.get("active")]
        if purpose is not None:
            rows = [r for r in rows if r.get("purpose") == purpose]
        return [_project(r, keys=AGENT_TEMPLATE_KEYS) for r in rows]

    def get(self, *, template_id: str) -> dict:
        """One active template including its subject and body.

        :param template_id: the id the draft cited.
        :returns: the raw row.
        :raises LookupError: if the template is absent or inactive. Deactivating a template must stop
            new drafts from using it, the same way deactivating a contact stops sends.
        """
        row = self._table.get_item(Key={"template_id": template_id}).get("Item")
        if row is None:
            raise LookupError(f"template {template_id!r} does not exist")
        if not row.get("active"):
            raise LookupError(f"template {template_id!r} is deactivated")
        return row

    def list_all(self) -> list[dict]:
        """Every template including inactive ones — operator console only.

        :returns: the raw rows.
        """
        return self._scan()

    def put(self, *, template: dict, actor: str) -> dict:
        """Create or replace one template, validating its placeholders against its declaration.

        :param template: must carry ``template_id``, ``name``, ``purpose``, ``subject_template``,
            ``body_template`` and ``variables``.
        :param actor: the authenticated principal making the change.
        :returns: the row as written, with ``revision`` set.
        :raises ValueError: on a missing attribute, an unknown ``purpose``, or a placeholder in
            either template that ``variables`` does not declare. Validated on save rather than on
            render so a broken template cannot be stored at all — by render time the operator who
            could fix it is no longer looking.
        """
        for key in ("template_id", "name", "purpose", "subject_template", "body_template"):
            if not template.get(key):
                raise ValueError(f"template is missing {key}")
        if template["purpose"] not in TEMPLATE_PURPOSES:
            raise ValueError(
                f"template purpose {template['purpose']!r} is not one of "
                f"{', '.join(TEMPLATE_PURPOSES)}"
            )
        declared = set(template.get("variables") or [])
        used = placeholders_in(template=template["subject_template"]) | placeholders_in(
            template=template["body_template"]
        )
        undeclared = sorted(used - declared)
        if undeclared:
            raise ValueError(f"template uses undeclared variables: {', '.join(undeclared)}")
        existing = (
            self._table.get_item(Key={"template_id": template["template_id"]}).get("Item") or {}
        )
        now = _now()
        # Revision 0 on create, then +1 per save. Matches build_persisted_draft's draft revisions so
        # the two numbers mean the same thing when they sit side by side on a case.
        revision = 0 if not existing else int(existing.get("revision", 0)) + 1
        row = {
            **template,
            "variables": list(template.get("variables") or []),
            "active": bool(template.get("active", existing.get("active", True))),
            "revision": revision,
            "created_by": existing.get("created_by", actor),
            "created_at": existing.get("created_at", now),
            "updated_by": actor,
            "updated_at": now,
        }
        self._table.put_item(Item=row)
        return row

    def deactivate(self, *, template_id: str, actor: str) -> None:
        """Soft-delete one template.

        :param template_id: the template to deactivate.
        :param actor: the authenticated principal making the change.
        :returns: None.
        :raises LookupError: if no such template exists.
        """
        existing = self._table.get_item(Key={"template_id": template_id}).get("Item")
        if existing is None:
            raise LookupError(f"template {template_id!r} does not exist")
        self._table.put_item(
            Item={**existing, "active": False, "updated_by": actor, "updated_at": _now()}
        )

    def _scan(self) -> list[dict]:
        """Every row in the table, following pagination.

        :returns: the raw items.
        """
        return _scan_all(table=self._table)


def _scan_all(*, table) -> list[dict]:
    """Scan a whole table, following ``LastEvaluatedKey``.

    These tables are small enough that one page is the norm, but an unfollowed pagination token is a
    silent truncation — the kind of bug that shows up as one recipient mysteriously missing from the
    Config tab once the table grows.

    :param table: a boto3 DynamoDB Table resource.
    :returns: every item in the table.
    """
    items: list[dict] = []
    kwargs: dict = {}
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        token = resp.get("LastEvaluatedKey")
        if not token:
            return items
        kwargs["ExclusiveStartKey"] = token
