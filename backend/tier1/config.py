"""Runtime configuration for the Tier-1 deterministic route.

An operator can turn the deterministic auto-match tier on or off while the system is running, with no
redeploy, by writing an SSM parameter from the Config UI. The stream consumer reads it once per
invocation batch, through a short in-process cache so a burst of batches does not turn into a burst of
SSM calls.
"""

import os
import time
from typing import Optional

import boto3

# Environment variable naming the SSM parameter, which holds the string "true" or "false". Terraform
# injects the name, so the code never hard-codes a parameter path.
_PARAM_NAME_ENV = "TIER1_ENABLED_PARAM"

# How long a fetched value stays good, in seconds. Short enough that flipping the switch takes effect
# within a batch or two, long enough that a burst of stream batches shares one read.
_CACHE_TTL_SECONDS = 30
_cache: dict[str, object] = {"value": None, "fetched_at": 0.0}

_ssm_client = None


def _ssm():
    """Build the SSM client on first use and reuse it afterwards.

    Lazy rather than module-level so importing this module needs no credentials, which is what lets
    the tests exercise the unconfigured path without any AWS setup.

    :returns: the shared boto3 SSM client.
    """
    global _ssm_client
    if _ssm_client is None:
        _ssm_client = boto3.client("ssm")
    return _ssm_client


def tier1_enabled(*, now: Optional[float] = None) -> bool:
    """Report whether the deterministic Tier-1 route should run.

    The value comes from the SSM parameter named by the ``TIER1_ENABLED_PARAM`` environment variable.
    Two failure modes get opposite treatment, and the difference is the point of this function.

    When no parameter is configured at all, meaning the environment variable is unset, this returns
    True. Nobody has expressed a preference, and that keeps a local or dev run working without any SSM
    setup, which is how the code behaved before the switch existed.

    When a parameter IS configured but the read fails, this raises. An operator has expressed a
    preference and we cannot see it. Guessing "enabled" there could quietly ignore a deliberate
    "disable", which is a correctness bug rather than an inconvenience.

    :param now: injectable clock in seconds, for testing the cache; defaults to ``time.time()``.
    :returns: True if deterministic matching should run.
    """
    param_name = os.environ.get(_PARAM_NAME_ENV)
    if not param_name:
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
