"""Which Bedrock model the Tier-2 agent invokes, read live from SSM.

Read from SSM rather than a per-backend environment variable, so changing it is a Config-tab click
and not a merge plus an apply. Comparing two models on the same queue is the most common thing
anyone wants to do with this platform; it should not be the one thing that needs an infrastructure
change, particularly when switching the agent *backend* is already a click.

Both Tier-2 backends read through this module — ``backend/harness_agent/worker.py`` and
``agent-blueprint/recon-agent/agent.py``. Wiring only one of them is the failure mode to avoid here:
the two paths look interchangeable from the Config tab, so a half-applied setting reads as the
control being broken rather than as a missing call site.
"""

import logging

logger = logging.getLogger(__name__)

# The model ids an operator may select, as cross-region inference profiles.
#
# Curated rather than derived from ``bedrock list-inference-profiles`` at runtime: the account exposes
# dozens of profiles, most of which this agent's prompts and tool schemas have never been exercised
# against, and an operator choosing one from a dropdown has no way to know that. Every id here is one
# the platform is expected to work with.
#
# The ``global.`` variants are NOT a faster tier. They may route the inference request outside the
# US, which is a data-residency decision and is invisible in the id, so the Config tab labels the
# choice as such rather than leaving it to be read as a performance knob.
#
# KEEP IN SYNC with AGENT_MODEL_IDS in
# ``chatbot-app/frontend/src/app/api/recon/config/route.ts``. There is no shared schema layer between
# the Python runtime and the TypeScript BFF, so this duplication is deliberate and has to be
# maintained by hand — a value this side rejects but that side accepts is a save that appears to work
# and then silently falls back.
ALLOWED_MODEL_IDS: tuple[str, ...] = (
    "us.anthropic.claude-opus-5",
    "global.anthropic.claude-opus-5",
    "us.anthropic.claude-sonnet-5",
    "global.anthropic.claude-sonnet-5",
    "us.anthropic.claude-fable-5-1",
    "global.anthropic.claude-fable-5-1",
)


def get_agent_model_id(param_name: str, *, default: str, ssm=None) -> str:
    """Read the operator-selected Tier-2 model id from SSM, falling back to the deployed default.

    Fails SOFT, which is the opposite call from ``auto_resolve.get_threshold`` in the same package,
    and the difference is deliberate. An unreadable threshold must disable auto-resolve, because the
    risk there is acting on a case without a human. An unreadable model id has no safe-by-omission
    answer: there is no such thing as reconciling with no model, so failing hard would strand every
    escalation on a transient SSM error. Falling back to the value the deploy chose keeps the queue
    moving with a known-good model, and says so at WARNING.

    The allowlist is enforced on READ as well as on write. The Config tab validates what it saves,
    but a hand-edited parameter never passes through it, and an id this function let through would
    surface as a per-invocation Bedrock error rather than as a configuration problem.

    :param param_name: the SSM parameter holding the selected model id. An empty string means the
        parameter was never wired, so the deployed default stands.
    :param default: the model id to use when the parameter is unset, unreadable, or not allowed.
        Normally the backend's deploy-time environment variable.
    :param ssm: an SSM client, injected by tests. A real client is created lazily when None.
    :returns: the model id to invoke.
    """
    if not param_name:
        return default
    try:
        if ssm is None:
            import boto3

            ssm = boto3.client("ssm")
        raw = ssm.get_parameter(Name=param_name)["Parameter"]["Value"].strip()
    except Exception as exc:  # noqa: BLE001 - see the docstring: a config read must not stall the queue
        logger.warning(
            "agent model id read failed (%s): %s — falling back to the deployed default %s",
            param_name,
            exc,
            default,
        )
        return default
    # An empty value is the normal pre-seed state, not a fault, so it gets no warning. An unknown
    # value is a fault and gets one, naming what was rejected: the operator who set it is otherwise
    # left watching a saved selection have no effect.
    if not raw:
        return default
    if raw not in ALLOWED_MODEL_IDS:
        logger.warning(
            "agent model id %r from %s is not in the allowlist — falling back to the deployed "
            "default %s",
            raw,
            param_name,
            default,
        )
        return default
    return raw
