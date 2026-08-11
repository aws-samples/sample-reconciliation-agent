"""search_correspondence tool: a mailbox search the model can actually be handed.

Registered as the ``correspondence-search`` target on the egress tools gateway. It exists purely
to give the Graph mailbox read a **sanitized argument surface**.

The problem it solves: the ``microsoft-graph`` OpenAPI target advertises the Graph OData query
parameters as tool-schema property names — ``$top`` and ``$search``. Bedrock's tool-schema
property pattern is ``^[a-zA-Z0-9_.-]{1,64}$``, so a ``$``-prefixed name is rejected and
``ConverseStream`` crashes the moment that tool is offered to a model. The AgentCore Harness has
no place to intercept its own toolset, so ``listSharedMailboxMessages`` simply cannot be
allowlisted there. The runtime backend gets away with it only because its Strands wrapper builds
the OData arguments in-process, out of the model's sight.

This target reproduces that wrapper server-side: the model calls
``search_correspondence(query, top)`` with plain, pattern-legal names, and the Lambda assembles
the OData form.

**Why this Lambda calls back through the gateway instead of calling Graph directly.** The Graph
credentials live in an AgentCore OAuth2 credential provider
(``microsoft-graph-obo-provider``), which the gateway's OpenAPI target resolves at call time.
There is no Lambda-readable copy of the Entra client secret, and creating one purely to shortcut
a hop would duplicate a credential and put a second, unaudited path to the tenant in the
account. So the Lambda re-enters the gateway with SigV4 and invokes
``microsoft-graph___listSharedMailboxMessages`` itself — the credential stays in one place and
the call still passes through the Policy engine and the REQUEST interceptor. There is no loop
risk: this target calls a *different* target, never itself.
"""

import os
from typing import Optional

from backend.recon_core.gateway_client import GatewayTransport, call_gateway_tool

# The upstream Graph OpenAPI operation this target wraps.
GRAPH_READ_TOOL = "microsoft-graph___listSharedMailboxMessages"

# Guardrails on `top`. The model supplies it, so it has to be bounded: Graph rejects a $top above
# its own page cap, and an unbounded value would pull an arbitrarily large mailbox page into a
# tool result the model then has to read.
DEFAULT_TOP = 10
MAX_TOP = 50


def _odata_search_literal(query: str) -> str:
    """Wrap a free-text query as a double-quoted OData ``$search`` literal.

    ``$search`` must be a double-quoted string: a bare value containing a hyphen or a space —
    i.e. nearly every reconciliation reference — is an OData syntax error, and it surfaces as an
    opaque MCP "unhandled errors in a TaskGroup" that the caller cannot diagnose. Inner double
    quotes are stripped rather than escaped, because Graph's ``$search`` does not accept an
    escaped quote inside the literal.

    :param query: the model's free-text search string.
    :returns: the quoted literal, e.g. ``'"DRW-2026-00417"'``.
    :raises ValueError: if the query is empty once stripped.
    """
    text = str(query).strip().replace('"', "")
    if not text:
        raise ValueError("query is required and must contain at least one non-quote character")
    return f'"{text}"'


def _coerce_top(raw: object) -> int:
    """Normalize the model-supplied ``top`` to a bounded int.

    ``$top`` must be a JSON integer — the Gateway's schema check rejects the string ``"10"`` a
    model may well emit, again as an opaque transport error. A tool schema's ``type: integer``
    is not enforced before the call reaches here, so coerce explicitly.

    :param raw: whatever arrived in the event (absent, int, float, or numeric string).
    :returns: an int in ``[1, MAX_TOP]``; ``DEFAULT_TOP`` when absent.
    :raises ValueError: when a value was supplied but is not a whole number.
    """
    if raw is None or raw == "":
        return DEFAULT_TOP
    try:
        top = int(str(raw).strip())
    except (TypeError, ValueError):
        raise ValueError(f"top must be a whole number, got {raw!r}")
    if top < 1:
        raise ValueError(f"top must be at least 1, got {top}")
    return min(top, MAX_TOP)


def handle(
    event: dict,
    _context=None,
    *,
    transport: Optional[GatewayTransport] = None,
) -> dict:
    """Search the deployment's shared mailbox for messages relevant to a reconciliation item.

    Gateway Lambda targets receive the tool arguments as the event dict.

    :param event: ``{query: str, top?: int}``. ``query`` is free text; ``top`` bounds the result
        count. The mailbox is NOT an argument — it is fixed per deployment via ``GRAPH_MAILBOX``
        so the model cannot redirect the read at another tenant mailbox.
    :param _context: Lambda context (unused).
    :param transport: test seam forwarded to ``call_gateway_tool``; production leaves it None.
    :returns: the upstream Graph tool's MCP result, unchanged — this target translates arguments
        only, never the payload, so the model sees exactly what the runtime backend sees.
    :raises ValueError: on an empty ``query``, a non-integer ``top``, or an unset
        ``GRAPH_MAILBOX`` (fail loudly — a blank mailbox would make Graph 404 with a far less
        obvious message).
    :raises RuntimeError: propagated from ``call_gateway_tool`` when the gateway, the Policy
        engine, the interceptor, or Graph itself rejects the read.
    """
    mailbox = os.environ.get("GRAPH_MAILBOX", "").strip()
    if not mailbox:
        raise ValueError("GRAPH_MAILBOX is not configured for the correspondence-search target")

    arguments = {
        "mailboxAddress": mailbox,
        "$search": _odata_search_literal(event.get("query", "")),
        "$top": _coerce_top(event.get("top")),
    }
    return call_gateway_tool(GRAPH_READ_TOOL, arguments, transport=transport)
