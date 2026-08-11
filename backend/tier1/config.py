"""Runtime configuration for the Tier-1 deterministic route.

The deterministic auto-match tier can be turned on/off at runtime (no redeploy) via an SSM
Parameter Store parameter. The Config UI writes it; this Lambda reads it per invocation batch
with a short in-process cache so a stream batch does not hammer SSM.
"""

import os
import time
from typing import Optional

import boto3

# Parameter holding "true"/"false". Name is injected by Terraform.
_PARAM_NAME_ENV = "TIER1_ENABLED_PARAM"

# Cache the value briefly so a burst of stream batches shares one SSM read. AGE in seconds.
_CACHE_TTL_SECONDS = 30
_cache: dict[str, object] = {"value": None, "fetched_at": 0.0}

_ssm_client = None


def _ssm():
    """Lazily build (and reuse) the SSM client so tests can run without one."""
    global _ssm_client
    if _ssm_client is None:
        _ssm_client = boto3.client("ssm")
    return _ssm_client


def tier1_enabled(*, now: Optional[float] = None) -> bool:
    """Return whether the deterministic Tier-1 route is enabled.

    Reads the SSM parameter named by ``$TIER1_ENABLED_PARAM``. Fails SAFE toward *enabled*
    only when no parameter is configured (env unset) — that preserves the historical default
    for local/dev without SSM. If the parameter IS configured but the read fails, we raise,
    because silently ignoring an operator's "disable" switch would be a correctness bug.

    :param now: injectable clock (seconds) for testing the cache; defaults to time.time().
    :returns: True if Tier-1 deterministic matching should run.
    """
    param_name = os.environ.get(_PARAM_NAME_ENV)
    if not param_name:
        # No config wired (local/dev) -> keep the deterministic tier on, as it was originally.
        return True

    clock = now if now is not None else time.time()
    cached = _cache["value"]
    if cached is not None and (clock - float(_cache["fetched_at"])) < _CACHE_TTL_SECONDS:
        return bool(cached)

    resp = _ssm().get_parameter(Name=param_name)
    value = resp["Parameter"]["Value"].strip().lower() == "true"
    _cache["value"] = value
    _cache["fetched_at"] = clock
    return value
