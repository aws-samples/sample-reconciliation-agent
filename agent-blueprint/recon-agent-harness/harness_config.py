"""Single source of truth for the recon harness's tools, skills, and lifecycle/model defaults.

Imported by BOTH the Terraform manage script (create/update-time) and the worker (invoke-time)
so the two configs cannot drift. The harness calls everything as tools:
  * an ``agentcore_gateway`` tool (awsIam outbound) exposing the egress tools gateway — READS ONLY
    on this backend (search_ledger, search_guidance, get_results, and the sanitized mailbox read
    search_correspondence);
  * an ``inline_function`` ``submit_proposal`` the worker executes to turn the agent's structured
    output into a persisted proposal (the model never picks the ledger reference — the worker
    derives it from recorded search_ledger results; see intake.derive_reference).

Nothing the model can call leaves the operator. A counterparty email is DATA the model writes into
``submit_proposal``'s ``email_draft``, which the platform persists for a human to approve, edit or
discard; the send itself happens later, from the BFF, against the approved revision. The send op is
on the gateway but not on ALLOWED_TOOLS, so the model is not merely refused at the gateway — it is
never offered the tool at all.
"""

# Gateway-prefixed tool names, mirroring gateway_mcp.GATEWAY_TOOL_NAMES — a DESCRIPTION of the
# gateway's tool surface, NOT the list the model may call. The enforced list is ALLOWED_TOOLS
# below, and it is a strict subset: anything present here but absent there is never offered to the
# model. (Mistaking this list for the allowlist is what made two harness runs look like model
# tool-selection behaviour when the tools were simply not on offer — see
# the Graph read-argument normalization design record.)
GATEWAY_TOOLS = [
    "general-ledger___search_ledger",
    "knowledge-base___search_guidance",
    "document-extraction___IDPTools___get_results",  # IDP MCP nests tools under the IDPTools group
    # NOTE: set-draw-status___set_draw_status is deliberately ABSENT — the model is
    # propose-only on this backend; the WORKER executes the Policy-gated ledger write through
    # the gateway after intake.decide says "execute".
    # Listed because the gateway exposes it, NOT because the model may call it: the send is a
    # platform action taken on an approved draft, so this name is absent from ALLOWED_TOOLS.
    "microsoft-graph___sendSharedMailboxMail",
    # The mailbox READ the model actually calls: a sanitized Lambda target that takes clean
    # `query`/`top` params and assembles the OData form server-side.
    "correspondence-search___search_correspondence",
    # The raw Graph read op is on the gateway but NOT in ALLOWED_TOOLS — its `$`-prefixed OData
    # arguments surface as tool-schema property names and violate Bedrock's property pattern, so
    # only correspondence-search (and the runtime's in-process wrapper) may call it. See the
    # ALLOWED_TOOLS comment.
    "microsoft-graph___listSharedMailboxMessages",
]

SUBMIT_PROPOSAL = "submit_proposal"

# Proposable ledger statuses — mirrors set_draw_status's allowlist so the model cannot drive an
# out-of-domain state onto the ledger (defense-in-depth alongside the Lambda allowlist).
PROPOSABLE_STATUSES = ["Cancelled", "Confirmed", "OnHold", "Amended"]

# The inline_function the agent calls exactly once to emit its machine-parseable proposal. The
# model supplies its classification + resolution + (optional) proposed status/reason + evidence.
# It does NOT supply the ledger reference — the worker derives that from the recorded
# search_ledger output so a model cannot redirect a write (F1).
SUBMIT_PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "class_name": {
            "type": "string",
            "description": "Chosen classification type name from the SKILL.md catalog.",
        },
        "classification_reasoning": {
            "type": "string",
            "description": "Why this classification type was chosen.",
        },
        "classification_confidence": {
            "type": "number",
            "description": "0..1 confidence in the classification (used only when IDP's class confidence is absent).",
        },
        "resolution": {
            "type": "string",
            "description": ("REQUIRED. Human-readable proposed resolution for the reconciliation "
                            "break (one to two sentences). Distinct from `reason`: always supply "
                            "`resolution` even when you also set `status`/`reason`."),
        },
        "verbalized_confidence": {
            "type": "number",
            "description": "0..1 overall confidence in the proposed resolution.",
        },
        "status": {
            "type": "string",
            "enum": PROPOSABLE_STATUSES,
            "description": "Proposed ledger status to set. Omit when no ledger write is warranted.",
        },
        "reason": {
            "type": "string",
            "description": ("Optional short note for the status change (recorded on the ledger "
                            "overlay). Does NOT replace `resolution` — provide both."),
        },
        "evidence": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Cited evidence values that appear verbatim in the item data or tool outputs.",
        },
        # Optional (absent from `required`). The model writes the message but neither sends it nor
        # picks the address: an analyst reviews the text, supplies the recipient and approves the
        # send. `recipient` is deliberately NOT a property here — items arrive from documents an
        # outside party wrote, so a model-authored address is attacker-influenceable.
        "email_draft": {
            "type": "object",
            "description": ("Optional counterparty email for a human to review, edit and send. "
                            "Include ONLY when settling the item genuinely requires asking the "
                            "counterparty something. Write it as if it will be sent verbatim."),
            "properties": {
                "recipient_hint": {
                    "type": "string",
                    "description": ("The counterparty's NAME as it appears in the item or a tool "
                                    "output — not an email address."),
                },
                "subject": {"type": "string", "description": "Subject line."},
                "body": {"type": "string", "description": "Plain-text message body."},
            },
            "required": ["subject", "body"],
        },
    },
    "required": [
        "class_name",
        "classification_reasoning",
        "resolution",
        "verbalized_confidence",
    ],
}

# allowedTools: the gateway tools + the single inline_function. maxIterations bounds the loop;
# lifecycle keeps sessions short (escalations-only volume). Model is parameterized by Terraform.
# allowedTools uses @server/tool patterns (harness-tools docs): gateway tools must be scoped
# by the TOOL ENTRY name ("egress-tools"). Plain gateway names match NOTHING and silently
# filter every gateway tool out of the model's toolset (observed live 2026-07-26).
#
# Graph ops on this list — verified against a live gateway tools/list on 2026-08-07:
#   * sendSharedMailboxMail: EXCLUDED, on purpose and not for a schema reason (it advertises only
#     `mailboxAddress`/`saveToSentItems`/`message`, all pattern-compliant, so it would work if
#     offered). The model writes the counterparty email into submit_proposal's `email_draft`
#     instead, and the send happens from the BFF once a human approves that text. Offering the tool
#     and relying on the gateway's email-confirmation gate to refuse it would also be safe — the
#     model cannot obtain the token — but it would put a "send email" affordance in front of a
#     model whose every send is destined to be denied, which teaches the model nothing and makes
#     the audit trail read as if outbound email were part of the agent's job. It is not: the agent
#     drafts, a human decides.
#   * listSharedMailboxMessages: EXCLUDED as well, and genuinely unusable as-is — the gateway
#     advertises its OData query parameters as inputSchema property names `$top`/`$search`, which
#     violate Bedrock's tool-schema property pattern ^[a-zA-Z0-9_.-]{1,64}$ and crash
#     ConverseStream if forwarded. The mailbox read reaches this backend through
#     `correspondence-search___search_correspondence` instead: a recon-owned Lambda target whose
#     schema declares only `query`/`top`, and which assembles the OData arguments server-side
#     before re-entering the gateway to call the Graph op (backend/correspondence_tool/handler.py).
ALLOWED_TOOLS = [
    "@egress-tools/general-ledger___search_ledger",
    "@egress-tools/knowledge-base___search_guidance",
    "@egress-tools/document-extraction___IDPTools___get_results",
    "@egress-tools/correspondence-search___search_correspondence",
    SUBMIT_PROPOSAL,
]
# 20 (was 12): skill loads consume turns under the agent-skills feature — real items hit
# the 12-cap mid-investigation (observed live 2026-07-26).
DEFAULT_MAX_ITERATIONS = 20
DEFAULT_IDLE_SECONDS = 60
DEFAULT_MAX_LIFETIME_SECONDS = 1800


def submit_proposal_tool() -> dict:
    """Return the CreateHarness ``inlineFunction`` tool entry for ``submit_proposal``.

    Shape matches the bedrock-agentcore-control model: ``{type, name, config: {inlineFunction:
    {description, inputSchema}}}`` where inputSchema is the raw JSON Schema document.
    """
    return {
        # NOTE: `type` is the snake_case enum value; the `config` sub-key is camelCase.
        "type": "inline_function",
        "name": SUBMIT_PROPOSAL,
        "config": {
            "inlineFunction": {
                "description": (
                    "Emit your final proposal for this reconciliation item. Call this EXACTLY "
                    "ONCE, after investigating. Do not include a ledger reference — it is derived "
                    "from your search_ledger results."
                ),
                "inputSchema": SUBMIT_PROPOSAL_SCHEMA,
            }
        },
    }


def gateway_tool(gateway_arn: str) -> dict:
    """Return the CreateHarness ``agentCoreGateway`` tool entry (awsIam outbound).

    :param gateway_arn: ARN of the egress tools gateway the harness calls with its execution role.
    """
    return {
        # NOTE: `type` is the snake_case enum value; the `config` sub-key is camelCase.
        "type": "agentcore_gateway",
        "name": "egress-tools",
        "config": {
            "agentCoreGateway": {"gatewayArn": gateway_arn, "outboundAuth": {"awsIam": {}}}
        },
    }


def tools(gateway_arn: str) -> list[dict]:
    """Full tools list for create/invoke: the egress gateway + the submit_proposal inline_function."""
    return [gateway_tool(gateway_arn), submit_proposal_tool()]
