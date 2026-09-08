"""Send the resolution-notification email via the Microsoft Graph gateway tool.

Routes through the egress tools gateway's ``microsoft-graph___sendSharedMailboxMail`` OpenAPI
operation (Graph ``POST /users/{mailboxAddress}/sendMail``, app-only, sent FROM the shared
mailbox) — the same single email channel the agent uses. No SES, and no Entra credentials in
this code path: the gateway's credential provider holds them.

Fails loudly — the approve path leaves the case APPROVED and surfaces the error on send
failure so the operator can retry, rather than silently resolving without notifying
downstream. The SigV4 MCP transport lives in ``backend.recon_core.gateway_client``.
"""

import os
from typing import Optional

from backend.recon_core.gateway_client import GatewayTransport, call_gateway_tool

# Gateway MCP tool name: {target}___{operation} (three underscores).
SEND_MAIL_TOOL = "microsoft-graph___sendSharedMailboxMail"


def _ui_link(item_id: str) -> str:
    """Build a link back to the case in the UI (base from env, best-effort).

    :param item_id: the recon item id.
    :returns: an absolute UI URL when ``RECON_UI_BASE`` is set, else a plain reference.
    """
    base = os.environ.get("RECON_UI_BASE", "")
    return f"{base}/recon/case/{item_id}" if base else f"(case {item_id})"


def send_resolution_email(
    case: dict,
    *,
    mailbox: str,
    contact_id: str,
    transport: Optional[GatewayTransport] = None,
) -> str:
    """Email the approved resolution to one internal-notification contact from the shared mailbox.

    The caller names a CONTACT, not an address. The address is resolved here, on this call, out of the
    operator's contacts table — so deactivating a recipient stops the mail immediately instead of at
    the next deploy, and no address for a human sits in an environment variable. The gateway
    interceptor reads the same table and refuses anything not on it, so a stale address resolved here
    would be denied there rather than delivered.

    :param case: the case record (``item_id``, ``domain``, ``class_id``, ``resolution``,
        ``confidence``).
    :param mailbox: shared mailbox SMTP address the mail is sent FROM (``GRAPH_MAILBOX``).
    :param contact_id: the ``internal_notification`` contact to notify.
    :param transport: test seam — ``callable(tool_name, arguments) -> result`` replacing the
        live SigV4 MCP round-trip. Production leaves it None.
    :returns: an identifier for the send, synthesized here because Graph sendMail returns no body.
        Kept so a log or audit line can name the send at all.
    :raises LookupError: when the contact is unknown, deactivated, or not of kind
        ``internal_notification``. Raised rather than skipped so the caller decides whether a
        missing notification is fatal — ``maybe_auto_resolve`` logs it and resolves anyway; the
        approve path surfaces it.
    :raises KeyError: when ``CONTACTS_TABLE`` is unset.
    :raises RuntimeError: when the gateway or the Graph operation reports an error.
    """
    from backend.contacts.store import ContactStore

    recipient = ContactStore(table=os.environ["CONTACTS_TABLE"]).resolve_address(
        contact_id=contact_id, kind="internal_notification"
    )
    item_id = case.get("item_id", "?")
    subject = f"[Recon] Resolved: {item_id} ({case.get('domain', '')})"
    body = (
        f"Reconciliation case {item_id} has been approved and resolved.\n\n"
        f"Domain:        {case.get('domain', '')}\n"
        f"Class:         {case.get('class_id', '')}\n"
        f"Resolution:    {case.get('resolution', '')}\n"
        f"Confidence:    {case.get('confidence', '')}\n\n"
        f"View: {_ui_link(item_id)}\n"
    )
    call_gateway_tool(
        SEND_MAIL_TOOL,
        {
            "mailboxAddress": mailbox,
            "message": {
                "subject": subject,
                "body": {"contentType": "Text", "content": body},
                "toRecipients": [{"emailAddress": {"address": recipient}}],
            },
            "saveToSentItems": True,
            # Human-confirmation token required by the gateway interceptor. This platform send
            # runs on the approve / auto-resolve path (a confidence-gated, human-or-policy-cleared
            # resolution), so it is authorized to carry the token; the agent's autonomous
            # counterparty-email tool has none. Stripped by the interceptor before Graph.
            "confirmationToken": os.environ.get("EMAIL_CONFIRMATION_TOKEN", ""),
            # What this send IS: internal status mail to one of the operator's own people. The
            # interceptor checks the sole recipient against the active `internal_notification`
            # contacts, so this branch cannot be used to reach anyone outside — mail leaving the
            # operator must instead go through `counterparty`, which requires an approved draft on a
            # case. Also stripped before Graph. An absent or unknown purpose is DENIED, so this is
            # not optional.
            "sendPurpose": "notification",
        },
        transport=transport,
    )
    # Graph sendMail is 202/no-body; return a stable ack for callers that log an id.
    return f"graph-send:{item_id}"
