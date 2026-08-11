"""Lock the harness tool/config shapes to the bedrock-agentcore-control CreateHarness contract."""

import harness_config as hc

GW = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/recon-dev-gateway-abc"


def test_gateway_tool_shape_matches_create_harness_contract():
    tool = hc.gateway_tool(GW)
    # `type` is the snake_case enum; the `config` sub-key is camelCase.
    assert tool["type"] == "agentcore_gateway"
    cfg = tool["config"]["agentCoreGateway"]
    assert cfg["gatewayArn"] == GW
    assert cfg["outboundAuth"] == {"awsIam": {}}


def test_submit_proposal_tool_is_inline_function_with_json_schema():
    tool = hc.submit_proposal_tool()
    assert tool["type"] == "inline_function"
    assert tool["name"] == "submit_proposal"
    schema = tool["config"]["inlineFunction"]["inputSchema"]
    assert schema["type"] == "object"
    # The model must NOT be asked for the ledger reference (worker derives it).
    assert "reference" not in schema["properties"]
    assert set(schema["required"]) >= {"class_name", "resolution", "verbalized_confidence"}


def test_allowed_tools_uses_server_scoped_patterns():
    """allowedTools requires @server/tool patterns (plain gateway names match nothing and
    silently filter every gateway tool out — observed live 2026-07-26)."""
    assert "@egress-tools/general-ledger___search_ledger" in hc.ALLOWED_TOOLS
    assert "@egress-tools/knowledge-base___search_guidance" in hc.ALLOWED_TOOLS
    assert "@egress-tools/document-extraction___IDPTools___get_results" in hc.ALLOWED_TOOLS
    # The model is propose-only: the WORKER executes the gated ledger write.
    assert not any("set_draw_status" in t for t in hc.ALLOWED_TOOLS)
    # The Graph SEND op is NOT offered. Not for a schema reason — its argument names are all
    # pattern-compliant and it would work — but because the counterparty email is data the model
    # writes into submit_proposal's `email_draft`, and the send is made later by the BFF from the
    # revision a human approved. The interceptor would refuse a model-originated send anyway; the
    # point of withholding the tool is that the model is never invited to try.
    assert not any("sendSharedMailboxMail" in t for t in hc.ALLOWED_TOOLS)
    # Withheld tool, offered schema field: the draft has somewhere to go.
    assert "email_draft" in hc.SUBMIT_PROPOSAL_SCHEMA["properties"]
    # The mailbox read is offered ONLY through the sanitized recon-owned target: its schema
    # declares plain `query`/`top`, and the Lambda assembles the OData form server-side.
    assert "@egress-tools/correspondence-search___search_correspondence" in hc.ALLOWED_TOOLS
    # The RAW Graph read op stays out: its $-prefixed OData params surface as tool-schema property
    # names, violate Bedrock's ^[a-zA-Z0-9_.-]{1,64}$ pattern, and crash ConverseStream.
    assert not any("listSharedMailboxMessages" in t for t in hc.ALLOWED_TOOLS)
    # No unscoped (pattern-less) gateway names — they match nothing.
    assert all(t.startswith("@egress-tools/") or t == "submit_proposal" for t in hc.ALLOWED_TOOLS)
    assert hc.ALLOWED_TOOLS[-1] == "submit_proposal"


def test_status_enum_matches_write_allowlist():
    assert hc.PROPOSABLE_STATUSES == ["Cancelled", "Confirmed", "OnHold", "Amended"]
    assert hc.SUBMIT_PROPOSAL_SCHEMA["properties"]["status"]["enum"] == hc.PROPOSABLE_STATUSES


def test_allowed_tools_is_a_subset_of_the_gateway_surface():
    """ALLOWED_TOOLS is the ENFORCED list; GATEWAY_TOOLS only describes the gateway's surface.

    Guards the confusion that made two live harness runs look like model tool-selection
    behaviour when the tools were simply never offered (2026-08-07): every scoped entry must
    correspond to a real gateway tool, so a typo in ALLOWED_TOOLS fails here rather than
    silently removing a tool from the model's toolset.
    """
    scoped = [t for t in hc.ALLOWED_TOOLS if t != hc.SUBMIT_PROPOSAL]
    bare = {t.removeprefix("@egress-tools/") for t in scoped}
    assert bare <= set(hc.GATEWAY_TOOLS), f"not on the gateway: {bare - set(hc.GATEWAY_TOOLS)}"


def test_system_prompt_only_advertises_tools_the_model_may_call():
    """The prompt's tool table must never name a gateway tool that ALLOWED_TOOLS filters out.

    Shipped defect (2026-08-07): the table instructed the model to call
    microsoft-graph___listSharedMailboxMessages and ___sendSharedMailboxMail, neither of which is
    in ALLOWED_TOOLS — so the model burned turns on tools it was never offered, and the two
    dependent skills were silently inert.

    This also guards the direction the send op just moved in. It left ALLOWED_TOOLS deliberately, so
    the prompt's tool table must not name it either — the prompt may only say, in prose, that no
    send tool exists.
    """
    import re
    from pathlib import Path

    prompt = (Path(hc.__file__).parent / "system-prompt.md").read_text()
    # Gateway tool names are `target___operation` (three underscores); the table lists them bare.
    named = set(re.findall(r"\b[a-z0-9-]+___[A-Za-z0-9_]+\b", prompt))
    allowed_bare = {t.removeprefix("@egress-tools/") for t in hc.ALLOWED_TOOLS}
    assert named <= allowed_bare, f"prompt advertises uncallable tools: {named - allowed_bare}"
