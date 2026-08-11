"""Gateway REQUEST interceptor: the gateway-layer trust boundary for write-class tools.

Configured as the egress gateway's single REQUEST interceptor, so it sees EVERY tool call —
from the agent, the worker, and the BFF alike — before the call reaches its target. It
enforces the two guards Cedar cannot express (they need a DynamoDB lookup):

  * ``set-draw-status___set_draw_status`` — **provenance**: the ``reference`` being written
    must equal the ``proposed_action.reference`` persisted on the case. No caller (model or
    platform) can redirect a ledger write to an arbitrary row.
  * ``recon-status___recon_update_status`` — the case state machine: the requested transition
    must be legal from the case's CURRENT stored status (same ``can_transition`` the tool
    Lambda itself uses — one state machine, enforced at the gateway too).
  * ``microsoft-graph___sendSharedMailboxMail`` — a confirmation token (capability) plus a
    declared ``sendPurpose``, both required. A ``counterparty`` send is checked for **provenance**
    the same way the ledger write is: the outgoing message must equal the draft a human approved on
    that case, at the revision they approved, to an address in ``COUNTERPARTY_EMAIL_DOMAINS``.
    Only that branch reads DynamoDB; a ``notification`` send compares against an env var and
    stays zero-I/O, which matters because this Lambda sits on every gateway call's critical path.
    An absent or unrecognized purpose is DENIED, so omission is never the permissive path.

Every other tool call (all reads, the other Graph ops) takes the pass-through fast path with
ZERO added I/O. Rollout is mode-gated via ``INTERCEPTOR_MODE``:

  * ``log`` (default) — never blocks; logs the would-be decision for observation.
  * ``enforce`` — rejects failing calls by short-circuiting: the gateway returns the
    interceptor's ``transformedGatewayResponse`` (a JSON-RPC tool error) without calling the
    target.

Failure policy: an internal error while checking one of the gated tools **fails closed** in
enforce mode (a guard we cannot evaluate must not allow a write, and the counterparty-send
branch does I/O so it can fail); non-gated tools cannot fail (no I/O). The handler is read-only
+ deterministic, hence idempotent (the gateway may retry interceptor invocations).
"""

import json
import logging
import os

import boto3

from backend.recon_core import email_policy
from backend.recon_core.status import CaseStatus, can_transition

logger = logging.getLogger(__name__)

WRITE_TOOL = "set-draw-status___set_draw_status"
STATUS_TOOL = "recon-status___recon_update_status"
# Email send: Cedar cannot gate it (OpenAPI ops carry no `confidence`), so the human-confirmation
# safeguard lives here. A send is allowed ONLY when it carries a confirmation token matching
# EMAIL_CONFIRMATION_TOKEN — a value provisioned to the human-driven send paths (the BFF ECS task
# + the approve/auto-resolve notify path) but NOT to the agent runtime container. The agent's
# autonomous counterparty-email tool therefore cannot send without a human in the loop. The token
# is STRIPPED before the request is forwarded, so it never reaches Graph (which rejects unknown
# fields) and never appears in a response.
SEND_TOOL = "microsoft-graph___sendSharedMailboxMail"
CONFIRM_ARG = "confirmationToken"
# What the send is FOR, declared by the caller. The token alone is a capability check — "does the
# caller hold the secret" — which says nothing about the message. The purpose selects which second
# check applies, and an absent or unrecognized value is DENIED, so omission is never the permissive
# path. Both extra arguments are stripped before forwarding, like the token (Graph 400s on unknown
# message fields).
PURPOSE_ARG = "sendPurpose"
ITEM_ARG = "reconItemId"
# Internal status mail to the operator's own address (approve/auto-resolve notifications). Checked
# against RECON_NOTIFY_EMAIL with no I/O.
PURPOSE_NOTIFICATION = "notification"
# Outbound mail to a party outside the operator, sent from an approved draft on a specific case.
PURPOSE_COUNTERPARTY = "counterparty"
# Mailbox read: the model reliably gets two OData details wrong, and both fail opaquely (the MCP
# client surfaces only "unhandled errors in a TaskGroup", so the model retries the same broken
# shape). Normalized here because the upstream contract is unambiguous and prompt guidance is
# empirically insufficient — the skill already shows $top as an integer and the model still sends a
# string. See the Graph read-argument normalization design record (D2/D3).
# Still needed even though `correspondence-search___search_correspondence` now assembles these
# arguments server-side: that wrapper is only one of this op's callers (the container runtime's
# in-process wrapper is the other), and the normalization is idempotent, so a correctly-formed call
# passes through untouched. This stays the last line of defence for the raw op.
READ_TOOL = "microsoft-graph___listSharedMailboxMessages"
TOP_ARG = "$top"
SEARCH_ARG = "$search"


def _pass_through(body: dict) -> dict:
    """Forward the (unmodified) request to the target.

    :param body: the JSON-RPC request body received from the gateway.
    :returns: the interceptor output envelope with a transformedGatewayRequest.
    """
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {"transformedGatewayRequest": {"body": body}},
    }


def _reject(body: dict, message: str) -> dict:
    """Short-circuit: the gateway responds with this JSON-RPC tool error, target never called.

    :param body: the JSON-RPC request body (its ``id`` is mirrored onto the error response).
    :param message: human-readable denial reason (lands in the caller's tool error).
    :returns: the interceptor output envelope with a transformedGatewayResponse.
    """
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": 200,
                "body": {
                    "jsonrpc": "2.0",
                    "id": body.get("id"),
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": f"denied by gateway interceptor: {message}"}],
                    },
                },
            }
        },
    }


def _case_row(item_id: str, *, ddb=None) -> dict | None:
    """Fetch the case row for ``item_id`` from the cases table.

    :param item_id: the case key.
    :param ddb: injectable DynamoDB resource (tests); real resource by default.
    :returns: the case item dict, or None when absent.
    """
    ddb = ddb or boto3.resource("dynamodb")
    resp = ddb.Table(os.environ["CASES_TABLE"]).get_item(Key={"item_id": item_id})
    return resp.get("Item")


def _check(tool: str, args: dict, *, ddb=None) -> str | None:
    """Evaluate the gateway-layer guard for one gated tool call.

    :param tool: full gateway tool name.
    :param args: the tool-call arguments.
    :param ddb: injectable DynamoDB resource (tests).
    :returns: a denial reason string, or None when the call is allowed.
    """
    item_id = (args.get("item_id") or "").strip()
    if not item_id:
        return f"{tool} requires item_id for the gateway-layer check"
    row = _case_row(item_id, ddb=ddb)

    if tool == WRITE_TOOL:
        action = (row or {}).get("proposed_action") or {}
        expected = action.get("reference")
        if not (isinstance(expected, str) and expected):
            return f"provenance: no persisted proposed_action.reference for item {item_id!r}"
        reference = (args.get("reference") or "").strip()
        if reference != expected:
            return f"provenance: reference {reference!r} does not match persisted {expected!r}"
        return None

    # STATUS_TOOL: the requested transition must be legal from the CURRENT stored status.
    if row is None:
        return f"no case found for item {item_id!r}"
    try:
        current = CaseStatus(row.get("status"))
        new = CaseStatus((args.get("new_status") or "").strip())
    except ValueError as exc:
        return f"invalid status: {exc}"
    if not can_transition(current, new):
        return f"illegal transition {current.value}->{new.value}"
    return None


def _message_parts(args: dict) -> tuple[list[str], str, str]:
    """Pull recipients, subject and body out of the Graph ``sendMail`` argument shape.

    Reads the raw operation's shape only — ``message.toRecipients[*].emailAddress.address``,
    ``message.subject``, ``message.body.content``. The flat ``{to, subject, body}`` form belongs to
    the runtime's own ``send_mail`` wrapper, which never reaches the gateway as such.

    :param args: the tool-call arguments (token/purpose already popped).
    :returns: ``(recipient addresses, subject, body content)``; missing pieces become empty.
    """
    message = args.get("message") or {}
    recipients = [
        str((((entry or {}).get("emailAddress") or {}).get("address")) or "").strip()
        for entry in (message.get("toRecipients") or [])
    ]
    subject = str(message.get("subject") or "")
    body = str(((message.get("body") or {}).get("content")) or "")
    return recipients, subject, body


def _check_send_purpose(*, purpose: str, item_id: str, args: dict, ddb=None) -> str | None:
    """Evaluate the declared purpose of an email send against what the message actually is.

    ``notification`` is the internal status mail the approve and auto-resolve paths send: its only
    legitimate destination is the operator's own ``RECON_NOTIFY_EMAIL``, so the check is an env-var
    comparison with no I/O.

    ``counterparty`` is mail leaving the operator. It is authorized by PROVENANCE, not capability:
    the case must carry a ``proposed_email`` a human approved, at the revision they approved, and
    the outgoing recipient/subject/body must equal it. A caller holding the confirmation token can
    then still only send text an analyst read.

    :param purpose: the declared ``sendPurpose`` (already lowercased/stripped).
    :param item_id: the declared ``reconItemId`` (empty when absent).
    :param args: the tool-call arguments (token/purpose/item already popped).
    :param ddb: injectable DynamoDB resource (tests).
    :returns: a denial reason string, or None when the send is authorized.
    """
    recipients, subject, body = _message_parts(args)
    # A single recipient is required for BOTH purposes: with two, "the recipient matches" is no
    # longer a statement about who receives the mail.
    if len(recipients) != 1:
        return f"expected exactly one recipient, got {len(recipients)}"
    recipient = recipients[0]

    if purpose == PURPOSE_NOTIFICATION:
        notify = os.environ.get("RECON_NOTIFY_EMAIL", "").strip()
        if not notify:
            return "RECON_NOTIFY_EMAIL is not configured"
        if recipient.lower() != notify.lower():
            return f"notification recipient {recipient!r} is not the configured notify address"
        return None

    if purpose == PURPOSE_COUNTERPARTY:
        if not item_id:
            return f"counterparty send requires {ITEM_ARG}"
        # The allowlist is checked HERE as well as in the BFF, and independently of the draft: the
        # persisted recipient could have been written before the operator narrowed the allowlist, or
        # by a compromised BFF that then approved its own draft. Provenance answers "did a human
        # approve this text"; the allowlist answers "is this an address it is ever legitimate to
        # write to", and neither implies the other. Empty allowlist ⇒ nothing is allowed.
        allowlist = email_policy.parse_domain_allowlist(
            os.environ.get("COUNTERPARTY_EMAIL_DOMAINS", "")
        )
        if not email_policy.is_recipient_allowed(address=recipient, allowlist=allowlist):
            return (
                f"recipient {recipient!r} is not in an allowed counterparty domain "
                f"({', '.join(allowlist) or 'none configured'})"
            )
        row = _case_row(item_id, ddb=ddb)
        if row is None:
            return f"no case found for item {item_id!r}"
        return email_policy.draft_matches_message(
            draft=row.get("proposed_email") or {},
            recipient=recipient,
            subject=subject,
            body=body,
        )

    return f"unrecognized {PURPOSE_ARG} {purpose or '<absent>'!r}"


def _handle_send(body: dict, params: dict, mode: str, *, ddb=None) -> dict:
    """Human-confirmation gate for the Graph email-send tool.

    Requires a confirmation token in the tool arguments matching ``EMAIL_CONFIRMATION_TOKEN``.
    The token is provisioned to the human-driven send paths (BFF / approve-notify), never to the
    agent runtime, so an autonomous agent send is denied. On success the token is STRIPPED from
    the forwarded arguments (Graph would 400 on the unknown field). ``log`` mode never blocks but
    still strips the token so a stray token never leaks to Graph.

    Both checks are ENFORCED: the token establishes that a human-driven path made the call, and the
    ``sendPurpose`` check establishes what the message is allowed to be. Either failing denies the
    send in enforce mode. They are independent and both required — a stolen token still cannot send
    text no analyst approved, and an approved draft still cannot be sent by the model.

    :param body: the JSON-RPC request body.
    :param params: ``body.params`` (``name`` + ``arguments``).
    :param mode: ``"log"`` or ``"enforce"``.
    :param ddb: injectable DynamoDB resource (tests).
    :returns: pass-through (extra args stripped) when both checks pass, else a rejection in enforce
        mode listing every reason (log mode logs the same reasons and forwards anyway).
    """
    args = dict(params.get("arguments") or {})
    expected = os.environ.get("EMAIL_CONFIRMATION_TOKEN", "").strip()
    provided = str(args.pop(CONFIRM_ARG, "")).strip()  # pop → strip from forwarded args
    purpose = str(args.pop(PURPOSE_ARG, "")).strip().lower()
    item_id = str(args.pop(ITEM_ARG, "")).strip()

    # Collected rather than short-circuited so one denial names everything wrong with the call.
    # Debugging a send that fails two checks one round-trip at a time is how a real approval gets
    # abandoned as "the button is broken".
    reasons: list[str] = []
    if not (bool(expected) and provided == expected):
        reasons.append(
            f"email requires human confirmation — no valid {CONFIRM_ARG} "
            "(the agent cannot send email autonomously)"
        )
    try:
        purpose_reason = _check_send_purpose(purpose=purpose, item_id=item_id, args=args, ddb=ddb)
    except Exception as exc:  # noqa: BLE001 - a check we cannot evaluate must not read as a pass
        purpose_reason = f"{PURPOSE_ARG} check failed: {type(exc).__name__}: {exc}"
    if purpose_reason is not None:
        reasons.append(purpose_reason)

    if reasons:
        logger.warning(
            "interceptor[%s] %s: %s", mode, SEND_TOOL, "; ".join(reasons)
        )
    if not reasons or mode != "enforce":
        # Forward with the extra arguments removed (whether they were valid, invalid, or absent) —
        # Graph 400s on unknown message fields, and in log mode a stray token must still not leak.
        new_body = dict(body)
        new_params = dict(params)
        new_params["arguments"] = args
        new_body["params"] = new_params
        return _pass_through(new_body)

    return _reject(body, "; ".join(reasons))


def _normalize_read_args(args: dict) -> tuple[dict, list[str]]:
    """Coerce the two Graph mailbox-read arguments the model gets wrong into their OData forms.

    ``$top`` must be an integer (the gateway validates tool arguments against the target's OpenAPI
    schema and rejects the string ``"10"``). ``$search`` must be a double-quoted string (Graph
    rejects any bare value containing ``-`` or spaces — i.e. every realistic reconciliation term).

    Both transforms are idempotent, as the interceptor contract requires: coercing an int is a
    no-op, and an already-quoted ``$search`` is left alone.

    :param args: the tool-call arguments as received from the model.
    :returns: ``(normalized_args, notes)`` — a new dict, plus one human-readable note per applied
        coercion (empty when nothing needed changing) for the caller to log.
    """
    out = dict(args)
    notes: list[str] = []

    # "10" -> 10. Only digit-strings; anything else is left for the schema to reject loudly rather
    # than guessed at (a float or "ten" is a real error, not a representation mismatch).
    top = out.get(TOP_ARG)
    if isinstance(top, str) and top.strip().isdigit():
        out[TOP_ARG] = int(top.strip())
        notes.append(f"{TOP_ARG}: string {top!r} -> int {out[TOP_ARG]}")

    # QA-E2E -> "QA-E2E". Skip values that are already double-quoted so a retry does not double up.
    search = out.get(SEARCH_ARG)
    if isinstance(search, str):
        stripped = search.strip()
        if stripped and not (stripped.startswith('"') and stripped.endswith('"') and len(stripped) > 1):
            # Inner double quotes would break the OData literal; drop them before wrapping.
            out[SEARCH_ARG] = '"{}"'.format(stripped.replace('"', ""))
            notes.append(f"{SEARCH_ARG}: {search!r} -> {out[SEARCH_ARG]!r} (OData requires a quoted string)")

    return out, notes


def _handle_read(body: dict, params: dict) -> dict:
    """Forward a mailbox-read call with its OData arguments normalized.

    Never denies: this is a read tool, so it follows the interceptor's fail-open posture. If
    normalization raises, the original arguments are forwarded unchanged — the worst outcome is the
    pre-existing failure, never a new denial.

    :param body: the JSON-RPC request body.
    :param params: ``body.params`` (``name`` + ``arguments``).
    :returns: pass-through with normalized arguments.
    """
    try:
        args, notes = _normalize_read_args(params.get("arguments") or {})
    except Exception as exc:  # noqa: BLE001 - reads fail open; never block on a normalization bug
        logger.warning("interceptor %s: normalization failed, forwarding as-is: %r", READ_TOOL, exc)
        return _pass_through(body)

    if not notes:
        return _pass_through(body)

    # Logged so model argument drift stays visible instead of being silently absorbed.
    logger.warning("interceptor %s: normalized OData args — %s", READ_TOOL, "; ".join(notes))
    new_body = dict(body)
    new_params = dict(params)
    new_params["arguments"] = args
    new_body["params"] = new_params
    return _pass_through(new_body)


def handle(event: dict, _context=None, *, ddb=None) -> dict:
    """REQUEST interceptor entry point (MCP-target payload contract, interceptor v1.0).

    :param event: ``{"interceptorInputVersion": "1.0", "mcp": {"gatewayRequest": {"body": …}}}``.
    :param _context: Lambda context (unused).
    :param ddb: injectable DynamoDB resource (tests).
    :returns: interceptor output — pass-through or a short-circuiting rejection.
    """
    body = ((event.get("mcp") or {}).get("gatewayRequest") or {}).get("body") or {}
    if isinstance(body, str):  # defensive: some payloads may arrive raw
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            return _pass_through(body)

    # Fast path: everything that is not a gated tools/call passes with zero I/O.
    if body.get("method") != "tools/call":
        return _pass_through(body)
    params = body.get("params") or {}
    tool = params.get("name") or ""

    mode = os.environ.get("INTERCEPTOR_MODE", "log").strip().lower()

    # Email send: human-confirmation gate AND purpose gate, both enforced. The token (stripped
    # before forwarding — Graph rejects unknown message fields) establishes that a human-driven path
    # made the call; the sendPurpose check establishes what the message is allowed to be. The agent
    # runtime holds no token, so its autonomous sends are blocked either way.
    if tool == SEND_TOOL:
        return _handle_send(body, params, mode, ddb=ddb)

    # Mailbox read: no gate, only an OData argument fix-up. Independent of INTERCEPTOR_MODE — this
    # is a correctness repair on the forwarded request, not an enforcement decision.
    if tool == READ_TOOL:
        return _handle_read(body, params)

    if tool not in (WRITE_TOOL, STATUS_TOOL):
        return _pass_through(body)
    try:
        reason = _check(tool, params.get("arguments") or {}, ddb=ddb)
    except Exception as exc:  # noqa: BLE001 - fail CLOSED for gated tools in enforce mode
        reason = f"gateway-layer check failed: {type(exc).__name__}: {exc}"

    if reason is None:
        return _pass_through(body)
    logger.warning("interceptor[%s] %s: %s", mode, tool, reason)
    if mode == "enforce":
        return _reject(body, reason)
    # log mode: observe only, never block.
    return _pass_through(body)
