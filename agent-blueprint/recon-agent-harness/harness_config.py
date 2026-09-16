"""Single source of truth for the recon harness's tools, skills, and lifecycle/model defaults.

Imported by BOTH the Terraform manage script (create/update-time) and the worker (invoke-time)
so the two configs cannot drift. The harness calls everything as tools:
  * an ``agentcore_gateway`` tool (awsIam outbound) exposing the egress tools gateway — READS ONLY
    on this backend (search_ledger, search_notices, the managed KB's Retrieve, and the sanitized
    mailbox read search_correspondence);
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
# tool-selection behaviour when the tools were simply not on offer.)
GATEWAY_TOOLS = [
    "general-ledger___search_ledger",
    "notices___search_notices",  # the ACTUAL side, mirroring general-ledger (the expected side)
    "managed-kb___Retrieve",  # managed bedrock-knowledge-bases connector; NOT a Lambda target
    # NOTE: there is no document-pipeline tool on this gateway. A document's extracted fields are
    # already on recon's own notice row (`idp_sections`), returned by notices___search_notices above.
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
    # The two reads that let the model cite a recipient and a wording BY ID instead of writing
    # either one. Note the different prefixes: the prefix is the gateway TARGET name, and there are
    # two targets in front of one Lambda precisely so these two names differ. Collapsing them onto
    # one target (`contacts___list_templates`) would silently filter the second tool out, because the
    # allowlist below would then not intersect the gateway's surface.
    "contacts___list_contacts",
    "templates___list_templates",
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
        # Deliberately NO confidence property. The model is never asked for a number about itself:
        # the only score is computed outside it, from `evidence_steps` below, by
        # `backend.recon_core.confidence.score_proposal`. Two such properties are specifically
        # excluded: a classification confidence, which as a threshold zeroes every case whose class
        # falls under it, and an overall resolution confidence, which no code reads but whose absence
        # still fails the parse. A property here is an instruction, so adding one teaches the model
        # that grading itself is part of the job and invites a reader to gate on it. Both names are
        # banned outright by tests/recon_core/test_single_confidence_signal.py, which is why this
        # comment describes them rather than spelling them.
        "resolution": {
            "type": "string",
            "description": (
                "REQUIRED. Human-readable proposed resolution for the reconciliation "
                "break (one to two sentences). Distinct from `reason`: always supply "
                "`resolution` even when you also set `status`/`reason`."
            ),
        },
        "status": {
            "type": "string",
            "enum": PROPOSABLE_STATUSES,
            "description": "Proposed ledger status to set. Omit when no ledger write is warranted.",
        },
        "reason": {
            "type": "string",
            "description": (
                "Optional short note for the status change (recorded on the ledger "
                "overlay). Does NOT replace `resolution` — provide both."
            ),
        },
        "evidence": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Cited evidence values that appear verbatim in the item data or tool outputs.",
        },
        # Deliberately absent from `required` below: the harness does not enforce `required` on
        # inline functions anyway (see backend/harness_agent/intake.py), and a hard failure here
        # would discard an otherwise-usable proposal. An absent report scores 0.0 and escalates,
        # which is the same outcome without losing the investigation's work.
        "evidence_steps": {
            "type": "array",
            "description": (
                "REQUIRED. One entry per evidence step your skill's front matter prescribes, in "
                "the order listed. `satisfied` is true ONLY if that step's tool call returned data "
                "answering it — not if you reasoned around it. Reporting a step you did not "
                "attempt as satisfied is the single most damaging error you can make here: the "
                "case may then be resolved with no human review."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "step_id": {"type": "string", "description": "The prescribed step's id."},
                    "satisfied": {"type": "boolean", "description": "Did it return data?"},
                    "note": {"type": "string", "description": "One line on what was found."},
                },
                "required": ["step_id", "satisfied"],
            },
        },
        # Optional (absent from `required`). The model picks WHO and WHICH WORDING from the
        # operator's own lists and fills the template's variables; it writes no prose. An analyst
        # reviews the rendered result and approves it, and approving is what authorises the send.
        # `recipient` is deliberately NOT a property here — items arrive from documents an outside
        # party wrote, so a model-authored address is attacker-influenceable. The platform resolves
        # the address from `recipient_contact_id` at send time, which is also what makes a contact
        # deactivated after approval unreachable.
        #
        # No `subject` or `body` property either, and that is the same guarantee rather than a
        # second one: `build_persisted_draft` renders the operator's templates and
        # `draft_matches_message` compares the approved bytes to the outgoing bytes, so text the
        # model wrote could never be stored, shown or sent. A prompt or skill that asks the model
        # for a subject line is describing a field that does not exist.
        "email_draft": {
            "type": "object",
            "description": (
                "Optional counterparty email for a human to review and send. Include "
                "ONLY when settling the item genuinely requires asking the counterparty "
                "something. You cite a recipient and a wording by id — you do not write "
                "the message and you never supply an address."
            ),
            "properties": {
                "recipient_contact_id": {
                    "type": "string",
                    "description": (
                        "A `contact_id` from contacts___list_contacts with kind "
                        "`counterparty`. The platform resolves it to an address at send "
                        "time; you never see one."
                    ),
                },
                "template_id": {
                    "type": "string",
                    "description": (
                        "A `template_id` from templates___list_templates with purpose "
                        "`counterparty`. The operator wrote the wording; you supply the "
                        "values it declares."
                    ),
                },
                "variables": {
                    "type": "object",
                    "description": (
                        "Values for EXACTLY the names in that template's `variables` "
                        "list — no more, no fewer. A mismatch leaves the draft visibly "
                        "unrenderable for an operator to fix."
                    ),
                },
                "recipient_hint": {
                    "type": "string",
                    "description": (
                        "The counterparty's NAME as it appears in the item or a tool "
                        "output — not an email address. Shown next to the contact you "
                        "cited so the reviewer can tell you picked the right one."
                    ),
                },
            },
            "required": ["recipient_contact_id", "template_id", "variables"],
        },
    },
    "required": [
        "class_name",
        "classification_reasoning",
        "resolution",
    ],
}

# allowedTools: the gateway tools + the single inline_function. maxIterations bounds the loop;
# lifecycle keeps sessions short (escalations-only volume). Model is parameterized by Terraform.
# allowedTools uses @server/tool patterns (harness-tools docs): gateway tools must be scoped
# by the TOOL ENTRY name ("egress-tools"). Plain gateway names match NOTHING and silently
# filter every gateway tool out of the model's toolset.
#
# Graph ops on this list, and why each is absent:
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
    "@egress-tools/notices___search_notices",
    # The KB reached through the gateway's managed `bedrock-knowledge-bases` connector. The
    # operation name is Bedrock's own (`Retrieve`, capital R), and its arguments are NESTED —
    # see system-prompt.md, which is the only place the model learns that shape on this backend
    # (there is no Python wrapper here, unlike the container runtime).
    "@egress-tools/managed-kb___Retrieve",
    "@egress-tools/correspondence-search___search_correspondence",
    # Neither read returns an address or a rendered message. `list_contacts` projects the `email`
    # attribute away before it answers, and `list_templates` returns the operator's wording with the
    # `{{variable}}` placeholders still in it. So offering both to the model widens what it can CITE
    # without widening what it can see or say — which is why these two are on the enforced list while
    # the send op is not.
    "@egress-tools/contacts___list_contacts",
    "@egress-tools/templates___list_templates",
    SUBMIT_PROPOSAL,
]
# Generous on purpose: skill loads consume turns under the agent-skills feature, so a real item
# spends several of these before it reaches its first tool call. A cap of 12 is hit mid-investigation.
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
        "config": {"agentCoreGateway": {"gatewayArn": gateway_arn, "outboundAuth": {"awsIam": {}}}},
    }


def tools(gateway_arn: str) -> list[dict]:
    """Full tools list for create/invoke: the egress gateway + the submit_proposal inline_function."""
    return [gateway_tool(gateway_arn), submit_proposal_tool()]


# ---------------------------------------------------------------------------------
# CloudFormation projection
#
# The harness is created by AWS::BedrockAgentCore::Harness inside an aws_cloudformation_stack
# (infra/modules/recon-agent-harness), because the Terraform provider's aws_bedrockagentcore_harness
# marks allowedTools, maxIterations and the lifecycle timeouts COMPUTED — unsettable — and its
# `skill` block takes only `path`, never an S3 URI.
#
# Terraform cannot import Python, so the values below are exported to a committed
# ``harness_config.json`` that HCL reads with jsondecode(file(...)). This module stays the
# authored source of truth; the JSON is DERIVED. Regenerate with:
#
#   python3 infra/scripts/gen_harness_config_json.py
#
# tests/harness_agent/test_harness_config_json.py fails if the committed JSON drifts from this
# module, so a forgotten regeneration is a red test rather than a silently stale deploy.
#
# Two shape differences from the boto3 projection above, both mandated by the CFN resource schema:
#   * property names are PascalCase (Type/Name/Config/AgentCoreGateway/GatewayArn/...), while the
#     `Type` VALUES stay snake_case enum members;
#   * InputSchema is a JSON object, not a JSON-encoded string.
# ---------------------------------------------------------------------------------

# The gateway ARN is only known at apply time, so it cannot be baked into a committed file.
# The exported tools carry this sentinel and Terraform substitutes the real ARN. Deliberately a
# value no ARN can collide with, so a failed substitution surfaces as an obviously bogus ARN in
# the CreateHarness call rather than as a subtly wrong one.
GATEWAY_ARN_SENTINEL = "__GATEWAY_ARN__"


def cfn_tools() -> list[dict]:
    """Return the Tools list in AWS::BedrockAgentCore::Harness shape.

    The gateway entry carries :data:`GATEWAY_ARN_SENTINEL` in place of the real ARN.

    :returns: list of CFN Tool property dicts (PascalCase keys, snake_case Type values).
    """
    return [
        {
            "Type": "agentcore_gateway",
            "Name": "egress-tools",
            "Config": {
                "AgentCoreGateway": {
                    "GatewayArn": GATEWAY_ARN_SENTINEL,
                    "OutboundAuth": {"AwsIam": {}},
                }
            },
        },
        {
            "Type": "inline_function",
            "Name": SUBMIT_PROPOSAL,
            "Config": {
                "InlineFunction": {
                    # Same text as submit_proposal_tool()'s description — read from there rather
                    # than re-typed, so the two projections cannot say different things to the model.
                    "Description": submit_proposal_tool()["config"]["inlineFunction"]["description"],
                    "InputSchema": SUBMIT_PROPOSAL_SCHEMA,
                }
            },
        },
    ]


def cfn_config() -> dict:
    """Return every harness setting Terraform needs, ready to serialize to harness_config.json.

    Keys are snake_case because HCL reads them as attribute names; the VALUES nested under
    ``tools`` are already in CloudFormation's PascalCase shape.

    :returns: dict with keys tools, allowed_tools, max_iterations, idle_runtime_session_timeout,
        max_lifetime, gateway_arn_sentinel.
    """
    return {
        "tools": cfn_tools(),
        "allowed_tools": ALLOWED_TOOLS,
        "max_iterations": DEFAULT_MAX_ITERATIONS,
        "idle_runtime_session_timeout": DEFAULT_IDLE_SECONDS,
        "max_lifetime": DEFAULT_MAX_LIFETIME_SECONDS,
        # Exported so the substitution string is defined in exactly one place: the Terraform side
        # reads it from here rather than hard-coding a copy of it that could drift.
        "gateway_arn_sentinel": GATEWAY_ARN_SENTINEL,
    }
