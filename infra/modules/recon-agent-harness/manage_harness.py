#!/usr/bin/env python3
"""Create-or-update the recon AgentCore Harness, poll READY, print its ARN as JSON.

Terraform's ``hashicorp/aws`` provider does not model AgentCore Harness, so the module drives
this boto3 script from a ``terraform_data`` provisioner (the same pattern as the gateway/policy
CLI shims). The script is idempotent: it finds an existing harness by name (ListHarnesses),
UpdateHarness if present else CreateHarness, polls GetHarness until READY (fail loudly on
*_FAILED with failureReason), and prints ``{"harness_arn": "..."}`` on stdout for a
``data "external"`` to read back.

Tool + skill + lifecycle config comes from the blueprint's ``harness_config.py`` (the single
source of truth shared with the worker) so create-time and invoke-time configs cannot drift.

Args (env): HARNESS_NAME, EXECUTION_ROLE_ARN, GATEWAY_ARN, MODEL_ID, SYSTEM_PROMPT,
SKILLS_S3_URIS (comma-separated), SUBNETS (comma-separated), SECURITY_GROUPS (comma-separated),
HARNESS_ENV_JSON (JSON object of harness environment variables — the OTel config),
AWS_REGION. ``--delete`` tears the harness down (destroy-time).
"""

import json
import os
import sys
import time

import boto3


def _harness_config():
    """Import the blueprint config (single source of truth for tools/allowedTools/lifecycle).

    Imported lazily (not at module top) so the read-only ``--lookup`` path — which does not need
    it and runs without HARNESS_CONFIG_DIR set — never fails on a missing module.
    """
    sys.path.insert(0, os.environ["HARNESS_CONFIG_DIR"])
    import harness_config

    return harness_config


def _client():
    """bedrock-agentcore-control client in the configured region."""
    return boto3.client("bedrock-agentcore-control", region_name=os.environ.get("AWS_REGION", "us-east-1"))


def _find_harness(ctl, name: str):
    """Return an existing harness dict for ``name`` (via ListHarnesses), or None."""
    resp = ctl.list_harnesses()
    for h in resp.get("harnesses", resp.get("items", [])):
        if h.get("harnessName") == name or h.get("name") == name:
            return h
    return None


def _skills() -> list:
    """Build the skills list from comma-separated S3 URIs (skills/<name>/ dirs)."""
    uris = [u.strip() for u in os.environ.get("SKILLS_S3_URIS", "").split(",") if u.strip()]
    return [{"s3": {"uri": uri}} for uri in uris]


def _network() -> dict:
    """VPC network config when subnets are provided, else PUBLIC."""
    subnets = [s for s in os.environ.get("SUBNETS", "").split(",") if s]
    if not subnets:
        return {"networkMode": "PUBLIC"}
    return {
        "networkMode": "VPC",
        "networkModeConfig": {
            "subnets": subnets,
            "securityGroups": [g for g in os.environ.get("SECURITY_GROUPS", "").split(",") if g],
        },
    }


def _environment_variables() -> dict:
    """Parse the harness environment variables from ``HARNESS_ENV_JSON``.

    Terraform passes the whole map as one JSON object (a provisioner env can only carry strings).
    These are the OTel knobs the harness runtime reads — span-noise reduction, the baggage
    span-attribute allow-list, semantic-convention opt-ins, and any third-party OTLP endpoint.

    :returns: a flat str→str map; empty when the variable is unset or ``{}``.
    :raises ValueError: when the value is not valid JSON, is not a JSON object, or holds a
        non-scalar value. A silently-dropped observability config is worse than a failed apply.
    """
    raw = os.environ.get("HARNESS_ENV_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"HARNESS_ENV_JSON is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"HARNESS_ENV_JSON must be a JSON object, got {type(parsed).__name__}")
    out = {}
    for key, value in parsed.items():
        if isinstance(value, (dict, list)):
            raise ValueError(f"HARNESS_ENV_JSON['{key}'] must be a scalar, got {type(value).__name__}")
        out[str(key)] = str(value)
    return out


def _config() -> dict:
    """Assemble the shared Create/UpdateHarness config from env + harness_config.py."""
    harness_config = _harness_config()
    gateway_arn = os.environ["GATEWAY_ARN"]
    env_vars = _environment_variables()
    return {
        "executionRoleArn": os.environ["EXECUTION_ROLE_ARN"],
        "model": {"bedrockModelConfig": {"modelId": os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-5")}},
        "systemPrompt": [{"text": os.environ.get("SYSTEM_PROMPT", "")}],
        "tools": harness_config.tools(gateway_arn),
        "skills": _skills(),
        "allowedTools": harness_config.ALLOWED_TOOLS,
        "memory": {"disabled": {}},
        "maxIterations": harness_config.DEFAULT_MAX_ITERATIONS,
        "environment": {
            "agentCoreRuntimeEnvironment": {
                "lifecycleConfiguration": {
                    "idleRuntimeSessionTimeout": harness_config.DEFAULT_IDLE_SECONDS,
                    "maxLifetime": harness_config.DEFAULT_MAX_LIFETIME_SECONDS,
                },
                "networkConfiguration": _network(),
            }
        },
        # Omitted entirely when empty: CreateHarness rejects an empty map, and sending {} on
        # update would wipe variables someone set out-of-band.
        **({"environmentVariables": env_vars} if env_vars else {}),
    }




def _poll_ready(ctl, harness_id: str, *, sleeper=time.sleep) -> dict:
    """Poll GetHarness until READY; raise on a *_FAILED status with its failureReason."""
    for _ in range(60):  # ~5 min at 5s
        h = ctl.get_harness(harnessId=harness_id)["harness"]
        status = h.get("status", "")
        if status == "READY":
            return h
        if status.endswith("FAILED"):
            raise RuntimeError(f"harness {harness_id} {status}: {h.get('failureReason')}")
        sleeper(5)
    raise RuntimeError(f"harness {harness_id} did not reach READY in time")


def _wait_gone(ctl, name: str, *, sleeper=time.sleep) -> None:
    """Poll ListHarnesses until no harness named ``name`` remains; raise if it never goes.

    Args:
        ctl: bedrock-agentcore-control client.
        name (str): harness name being torn down.
        sleeper (Callable[[float], None]): sleep function (injectable for tests).

    Returns:
        None
    """
    for _ in range(60):  # ~5 min at 5s
        if _find_harness(ctl, name) is None:
            return
        sleeper(5)
    raise RuntimeError(f"harness {name} still exists after delete; refusing to create a second one")


def create_or_update(ctl, name: str) -> dict:
    """Create-or-update the named harness and return the READY harness dict."""
    cfg = _config()
    existing = _find_harness(ctl, name)
    # A terraform_data REPLACE runs the destroy provisioner (--delete, which returns as soon as
    # DeleteHarness is accepted) immediately before this create, so the old harness is usually
    # still listed in DELETING. Updating it would fail; creating alongside it would collide on the
    # name. Wait for it to disappear, then create fresh.
    if existing and str(existing.get("status", "")).upper().startswith("DELET"):
        _wait_gone(ctl, name)
        existing = None
    if existing:
        hid = existing.get("harnessId") or existing.get("id")
        # UpdateHarness takes the SAME raw shapes as CreateHarness (botocore 1.43.48) — NOT
        # {optionalValue: ...} wrappers. Send the mutable config fields directly. Anything NOT
        # listed here is never updated on an existing harness, which is why environmentVariables
        # has to be passed on this path too and not only at create time.
        ctl.update_harness(
            harnessId=hid,
            model=cfg["model"],
            systemPrompt=cfg["systemPrompt"],
            tools=cfg["tools"],
            skills=cfg["skills"],
            allowedTools=cfg["allowedTools"],
            maxIterations=cfg["maxIterations"],
            **({"environmentVariables": cfg["environmentVariables"]}
               if "environmentVariables" in cfg else {}),
        )
    else:
        created = ctl.create_harness(harnessName=name, **cfg)
        hid = created.get("harnessId") or created["harness"]["harnessId"]
    return _poll_ready(ctl, hid)


def delete(ctl, name: str) -> None:
    """Delete the named harness if it exists (destroy-time; best-effort)."""
    existing = _find_harness(ctl, name)
    if existing:
        ctl.delete_harness(harnessId=existing.get("harnessId") or existing.get("id"))


def _find_harness_runtime_log_group(ctl, name: str) -> str:
    """Find the CloudWatch log group of the runtime the managed harness materializes.

    A harness named ``<name>`` runs as an AgentCore runtime named ``harness_<name>`` whose id
    suffix is service-generated (and changes when the harness is recreated), so the log group
    (`/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT`) cannot be derived statically. The
    online eval configs need this group in their data source: the evaluation service reads
    gen-ai event records ONLY from the configured log groups (never follows the spans'
    aws.log.group.names pointer).

    :param ctl: bedrock-agentcore-control boto3 client.
    :param name: the harness name (without the ``harness_`` runtime prefix).
    :returns: the log group name, or ``""`` when the runtime does not exist (yet).
    """
    runtime_name = f"harness_{name}"
    paginator = ctl.get_paginator("list_agent_runtimes")
    for page in paginator.paginate():
        for rt in page.get("agentRuntimes", []):
            if rt.get("agentRuntimeName") == runtime_name:
                return f"/aws/bedrock-agentcore/runtimes/{rt['agentRuntimeId']}-DEFAULT"
    return ""


def lookup(name: str, region: str) -> None:
    """Read-only: print {"harness_arn", "harness_runtime_log_group"} for the named harness
    ('' values if absent).

    Used by a Terraform ``data "external"``, which passes its ``query`` as JSON on stdin and
    requires a flat string→string JSON object on stdout — so this reads name/region from stdin.
    """
    ctl = boto3.client("bedrock-agentcore-control", region_name=region)
    existing = _find_harness(ctl, name)
    print(
        json.dumps(
            {
                "harness_arn": (existing or {}).get("arn", ""),
                "harness_runtime_log_group": _find_harness_runtime_log_group(ctl, name),
            }
        )
    )


def main() -> int:
    """Entry point: --delete tears down, --lookup reads the ARN, else create-or-update + print."""
    if "--lookup" in sys.argv:
        # data "external" contract: query arrives as JSON on stdin.
        query = json.load(sys.stdin) if not sys.stdin.isatty() else {}
        name = query.get("harness_name") or os.environ["HARNESS_NAME"]
        region = query.get("region") or os.environ.get("AWS_REGION", "us-east-1")
        lookup(name, region)
        return 0
    name = os.environ["HARNESS_NAME"]
    ctl = _client()
    if "--delete" in sys.argv:
        delete(ctl, name)
        return 0
    harness = create_or_update(ctl, name)
    print(json.dumps({"harness_arn": harness["arn"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
