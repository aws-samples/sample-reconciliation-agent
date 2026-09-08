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
    assert set(schema["required"]) >= {"class_name", "resolution"}


def test_allowed_tools_uses_server_scoped_patterns():
    """allowedTools requires @server/tool patterns (plain gateway names match nothing and
    silently filter every gateway tool out — observed live 2026-07-26)."""
    assert "@egress-tools/general-ledger___search_ledger" in hc.ALLOWED_TOOLS
    # The KB is reached through the managed bedrock-knowledge-bases connector, whose operation name
    # is Bedrock's own `Retrieve`. The retired Lambda-backed knowledge-base target must not linger
    # here: it stays deployed until Phase 3, so a leftover entry would keep working and hide the
    # migration rather than failing.
    assert "@egress-tools/managed-kb___Retrieve" in hc.ALLOWED_TOOLS
    assert not any("knowledge-base___" in t for t in hc.ALLOWED_TOOLS)
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


def test_search_notices_is_offered_on_the_harness() -> None:
    """The ACTUAL side must be on the ENFORCED list, not just the descriptive one.

    ALLOWED_TOOLS entries carry the ``@egress-tools/`` prefix; a bare gateway name matches nothing
    and silently filters the tool out of the model's toolset.
    """
    assert "@egress-tools/notices___search_notices" in hc.ALLOWED_TOOLS
    assert "notices___search_notices" in hc.GATEWAY_TOOLS


def test_prompt_table_names_every_gateway_tool_the_model_may_call() -> None:
    """The reverse of ``test_system_prompt_only_advertises_tools_the_model_may_call``.

    That guard asserts ``named <= allowed_bare``, so a tool present in ALLOWED_TOOLS but MISSING from
    the prompt's translation table passes it silently. On this backend skills use SHORT names and only
    that table maps them to gateway names, so an omitted row means the model calls e.g.
    ``search_notices`` and gets an unknown-tool error — while every existing test stays green.

    :returns: None.
    """
    from pathlib import Path

    prompt = (Path(hc.__file__).parent / "system-prompt.md").read_text()
    expected = {
        t.removeprefix("@egress-tools/") for t in hc.ALLOWED_TOOLS if t != hc.SUBMIT_PROPOSAL
    }
    missing = {t for t in expected if t not in prompt}
    assert not missing, f"prompt table omits callable tools: {missing}"


def test_contacts_tools_are_offered_and_allowed() -> None:
    """Both names, spelled out, in both lists — because the strings themselves are load-bearing.

    The prefix on a gateway tool IS the target name, so ``contacts___list_contacts`` and
    ``templates___list_templates`` require TWO gateway targets in front of one Lambda. A Terraform
    refactor that "simplified" them onto a single target would rename the second tool, and nothing
    else here would notice: the subset test would still pass (both lists would move together), the
    Cedar action match would silently stop matching, and the model would lose the templates read with
    no error anywhere. Asserting the literal strings is the only thing that catches it.

    :returns: None.
    """
    for name in ("contacts___list_contacts", "templates___list_templates"):
        assert name in hc.GATEWAY_TOOLS
        assert f"@egress-tools/{name}" in hc.ALLOWED_TOOLS
    # Different prefixes, not one target serving both operations.
    assert "contacts___list_templates" not in hc.GATEWAY_TOOLS


def test_email_draft_schema_requires_a_contact_id_and_forbids_a_recipient() -> None:
    """The model cites a recipient by id and has nowhere to write an address.

    Not a comment, an assertion: adding a ``recipient`` property back would be a one-line change that
    reads as a convenience, and it would hand a model-authored address — sourced from a document an
    outside party wrote — straight to the send path. The same goes for ``subject``/``body``: the
    wording is the operator's, cited by ``template_id``.

    :returns: None.
    """
    draft = hc.SUBMIT_PROPOSAL_SCHEMA["properties"]["email_draft"]
    props = draft["properties"]
    assert set(draft["required"]) == {"recipient_contact_id", "template_id", "variables"}
    for forbidden in ("recipient", "subject", "body"):
        assert forbidden not in props, f"the model must not author {forbidden}"
    # `recipient_hint` stays — it is a NAME for the reviewer to check the id against, and the
    # description has to keep saying so or a model will helpfully put an address there.
    assert "not an email address" in props["recipient_hint"]["description"]


def test_prompt_asks_for_evidence_step_outcomes() -> None:
    """The scored field must be in the submit contract, since nothing else forces the model to send it.

    The harness does not validate inline-function inputs, so an omitted field is not an error — it is
    a proposal that scores 0 and escalates.

    :returns: None.
    """
    from pathlib import Path

    prompt = (Path(hc.__file__).parent / "system-prompt.md").read_text()
    assert "evidence_steps" in prompt


def test_no_self_reported_confidence_in_the_submit_schema() -> None:
    """A tool property is an instruction. Asking for a number that nothing reads teaches the model
    that grading itself is part of the job, and invites a reader to start gating on it.

    Both fields used to be REQUIRED here. `classification_confidence` was thresholded against
    DEFAULT_CLASS_THRESHOLD, and on 2026-09-02 that scored every harness case 0.0 at once — the
    property was optional in practice (the harness does not enforce `required` on inline functions),
    an absent value read as 0.0, and 'unknown' declares no evidence_steps so nothing was scoreable.
    `verbalized_confidence` was required and read by nothing at all.

    :returns: None.
    """
    props = hc.SUBMIT_PROPOSAL_SCHEMA["properties"]
    assert "classification_confidence" not in props
    assert "verbalized_confidence" not in props
    assert set(hc.SUBMIT_PROPOSAL_SCHEMA["required"]) == {
        "class_name",
        "classification_reasoning",
        "resolution",
    }
    # The one thing the model IS asked to report about the work: which prescribed steps got data.
    assert "evidence_steps" in props
