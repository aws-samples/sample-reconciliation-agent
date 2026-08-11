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
    recipient: str,
    transport: Optional[GatewayTransport] = None,
) -> str:
    """Email the approved resolution to the configured recipient from the shared mailbox.

    :param case: the case record (``item_id``, ``domain``, ``class_id``, ``resolution``,
        ``confidence``).
    :param mailbox: shared mailbox SMTP address the mail is sent FROM (``GRAPH_MAILBOX``).
    :param recipient: notification recipient (``RECON_NOTIFY_EMAIL``).
    :param transport: test seam — ``callable(tool_name, arguments) -> result`` replacing the
        live SigV4 MCP round-trip. Production leaves it None.
    :returns: an identifier for the send (Graph sendMail returns no body; kept for log/audit
        parity with the old SES MessageId).
    :raises RuntimeError: when the gateway or the Graph operation reports an error.
    """
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
            # What this send IS: internal status mail to the operator's own notify address. The
            # interceptor checks the sole recipient against RECON_NOTIFY_EMAIL, so this branch
            # cannot be used to reach anyone outside — mail leaving the operator must instead go
            # through `counterparty`, which requires an approved draft on a case. Also stripped
            # before Graph. An absent or unknown purpose is DENIED, so this is not optional.
            "sendPurpose": "notification",
        },
        transport=transport,
    )
    # Graph sendMail is 202/no-body; return a stable ack for callers that log an id.
    return f"graph-send:{item_id}"
