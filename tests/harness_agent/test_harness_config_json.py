"""Contract: the committed harness_config.json matches harness_config.py.

Terraform reads ``agent-blueprint/recon-agent-harness/harness_config.json`` with
``jsondecode(file(...))`` to build the AWS::BedrockAgentCore::Harness properties, because HCL
cannot import Python and an apply must not depend on an interpreter being installed.

That makes the JSON a DERIVED artifact with a real failure mode: edit harness_config.py, forget to
regenerate, and the next apply deploys the previous tool surface — including the previous
``AllowedTools``, which is the list the service actually enforces. Nothing else catches that. These
tests are the catch.
"""

import json
import sys
from pathlib import Path

import harness_config as hc

# infra/scripts is not on the pythonpath (pyproject.toml lists only the repo root and the two
# blueprint dirs), so reach the generator the same way it reaches the blueprint.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import gen_harness_config_json as gen  # noqa: E402  (follows the sys.path insert, by necessity)

JSON_PATH = REPO_ROOT / "agent-blueprint" / "recon-agent-harness" / "harness_config.json"

REGENERATE = "python3 infra/scripts/gen_harness_config_json.py"


def test_committed_json_is_byte_identical_to_a_fresh_render():
    """The committed file must match the generator's output exactly, not just semantically.

    Compared as bytes so the pinned formatting (2-space indent, sorted keys, trailing newline) is
    part of the contract — otherwise a reformat produces a diff that reviewers learn to ignore.
    """
    assert JSON_PATH.read_text(encoding="utf-8") == gen.render(), (
        f"{JSON_PATH.relative_to(REPO_ROOT)} is stale. harness_config.py changed without "
        f"regenerating it, so Terraform would deploy the PREVIOUS harness config (tools, "
        f"AllowedTools, maxIterations, lifecycle timeouts). Run: {REGENERATE}"
    )


def test_json_carries_the_enforced_allowlist_not_the_descriptive_one():
    """AllowedTools is what the service enforces; GATEWAY_TOOLS is only a description of the surface.

    Exporting the wrong one would hand the model tools it is meant never to be offered — notably
    the raw Graph ops, which are excluded on purpose (see harness_config.ALLOWED_TOOLS).
    """
    exported = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    assert exported["allowed_tools"] == hc.ALLOWED_TOOLS
    assert "microsoft-graph___sendSharedMailboxMail" not in exported["allowed_tools"]
    assert "microsoft-graph___listSharedMailboxMessages" not in exported["allowed_tools"]


def test_gateway_arn_is_a_sentinel_and_never_a_real_arn():
    """The committed file must not pin a gateway ARN — Terraform substitutes it at apply time.

    A real ARN here would survive into a second environment and point its harness at the FIRST
    environment's gateway, which fails open: the harness is created, healthy, and reading another
    deployment's tools.
    """
    exported = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    gateway_tool = next(t for t in exported["tools"] if t["Type"] == "agentcore_gateway")
    arn = gateway_tool["Config"]["AgentCoreGateway"]["GatewayArn"]
    assert arn == hc.GATEWAY_ARN_SENTINEL
    assert not arn.startswith("arn:")
    # The Terraform side searches for this exact string, so it has to travel with the file.
    assert exported["gateway_arn_sentinel"] == hc.GATEWAY_ARN_SENTINEL


def test_cfn_projection_uses_pascalcase_keys_with_snakecase_type_values():
    """AWS::BedrockAgentCore::Harness rejects the boto3 camelCase shape.

    The two projections coexist in harness_config.py and are easy to cross-wire; `Type` values
    stay snake_case enum members while every property name is PascalCase.
    """
    tools = hc.cfn_tools()
    gw = next(t for t in tools if t["Type"] == "agentcore_gateway")
    assert set(gw) == {"Type", "Name", "Config"}
    assert gw["Config"]["AgentCoreGateway"]["OutboundAuth"] == {"AwsIam": {}}

    inline = next(t for t in tools if t["Type"] == "inline_function")
    fn = inline["Config"]["InlineFunction"]
    # InputSchema is a JSON OBJECT here, unlike the provider resource which takes a string.
    assert isinstance(fn["InputSchema"], dict)
    assert fn["InputSchema"]["type"] == "object"


def test_inline_function_description_is_shared_with_the_boto3_projection():
    """Both projections must describe submit_proposal identically — it is model-facing text."""
    inline = next(t for t in hc.cfn_tools() if t["Type"] == "inline_function")
    assert (
        inline["Config"]["InlineFunction"]["Description"]
        == hc.submit_proposal_tool()["config"]["inlineFunction"]["description"]
    )


def test_lifecycle_and_iteration_limits_survive_the_projection():
    """These are exactly the fields aws_bedrockagentcore_harness marks computed/unsettable.

    Losing them silently is the failure this whole CFN route exists to avoid: the harness would be
    created with service defaults instead of the 20-iteration cap and the short session lifetimes.
    """
    exported = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    assert exported["max_iterations"] == hc.DEFAULT_MAX_ITERATIONS == 20
    assert exported["idle_runtime_session_timeout"] == hc.DEFAULT_IDLE_SECONDS
    assert exported["max_lifetime"] == hc.DEFAULT_MAX_LIFETIME_SECONDS
