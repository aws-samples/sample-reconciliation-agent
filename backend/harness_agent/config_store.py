"""Versioned agent-config store: S3 config documents + SSM active-pointer.

The Config-versions panel in the Evals tab creates immutable config documents at
``s3://<assets>/harness-configs/v<NNNN>.json``, each with
``{version, created_at, comment, system_prompt, model_id, max_iterations, skills: [names]}``.
An SSM parameter holds the deployed version string (e.g. ``"v0007"``). Deploy and rollback are
the same operation: PutParameter.

The worker reads the pointer + config at invocation time and passes them as InvokeHarness
overrides (``model``, ``maxIterations``). Absent pointer or unreadable config → fall back to the
blueprint's defaults (zero-config backward compatible).

``system_prompt`` is stored in the document as the versioned RECORD of the prompt that version
deployed, but it is not applied as an invoke-time override: the deploy step writes it into the
shared ``system-prompt.md`` core object that both backends read (``recon_core.prompt_source``).
"""

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def active_version(*, ssm, param_name: str) -> str | None:
    """Read the active config version from SSM. Returns None when unset/disabled.

    :param ssm: boto3 SSM client.
    :param param_name: the SSM parameter name ('' disables).
    :returns: the version string (e.g. ``"v0007"``), or None.
    """
    if not param_name:
        return None
    try:
        raw = ssm.get_parameter(Name=param_name)["Parameter"]["Value"].strip()
        # "none" or "" = no active version (use defaults). Only "v..." strings are real versions.
        return raw if raw.startswith("v") else None
    except Exception as exc:  # noqa: BLE001 - unreadable pointer → use defaults
        logger.warning("config-store pointer read failed (%s): %s", param_name, exc)
        return None


def load_config(*, s3, bucket: str, version: str) -> dict[str, Any] | None:
    """Load an immutable config document from S3.

    :param s3: boto3 S3 client.
    :param bucket: assets bucket.
    :param version: the version string (e.g. ``"v0003"``).
    :returns: the config dict, or None on any failure (caller uses defaults).
    """
    key = f"harness-configs/{version}.json"
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - missing config → use defaults
        logger.warning("config-store load failed (%s/%s): %s", bucket, key, exc)
        return None


def apply_overrides(*, config: dict, base_model: str, base_system_prompt: str) -> dict:
    """Build InvokeHarness overrides from a loaded config.

    The config's ``system_prompt`` is deliberately IGNORED here. Deploying a version writes that
    text into the shared core object (``system-prompt.md``), which both Tier-2 backends read — see
    ``backend/recon_core/prompt_source``. Applying it a second time at invoke time would resurrect
    the drift that fix removes: the harness would run the version's text while the runtime ran the
    core object's, and the harness's calling contract (appended to the core, absent from the
    version document) would be dropped from the prompt entirely.

    :param config: the parsed config document.
    :param base_model: fallback model id (used when config omits ``model_id``).
    :param base_system_prompt: the composed prompt (shared core + calling contract) to send.
    :returns: dict of InvokeHarness kwargs to merge (``model``, ``systemPrompt``,
        ``maxIterations``). Fields absent from the config use the base values.
    """
    model_id = config.get("model_id") or base_model
    overrides: dict[str, Any] = {
        "model": {"bedrockModelConfig": {"modelId": model_id}},
        "systemPrompt": [{"text": base_system_prompt}],
    }
    if config.get("max_iterations"):
        overrides["maxIterations"] = int(config["max_iterations"])
    return overrides
