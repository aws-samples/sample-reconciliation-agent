"""Tests for the versioned harness config store.

What these lock in: ``apply_overrides`` must NOT substitute the config document's ``system_prompt``
for the composed prompt. Doing so breaks two ways at once — the runtime backend never reads config
versions, so a "deployed" version changes nothing there; and on the harness the version's text
displaces the composed prompt, silently dropping the appended calling contract (submit_proposal field
names, prefixed gateway tool names) that the version document does not carry. The prompt travels
through the shared core object written at deploy time; this module overrides model + iteration count
only.
"""

from backend.harness_agent.config_store import active_version, apply_overrides, load_config


class _Ssm:
    """Minimal SSM stub returning a fixed parameter value (or raising)."""

    def __init__(self, *, value: str | None) -> None:
        self._value = value

    def get_parameter(self, *, Name: str) -> dict:  # noqa: N803 - boto3 kwarg casing
        if self._value is None:
            raise RuntimeError(f"ParameterNotFound: {Name}")
        return {"Parameter": {"Value": self._value}}


def test_apply_overrides_keeps_the_composed_prompt() -> None:
    """The config's system_prompt must NOT reach InvokeHarness — the composed prompt wins."""
    overrides = apply_overrides(
        config={"system_prompt": "OPTIMIZED TEXT", "model_id": "us.anthropic.claude-opus-5"},
        base_model="us.anthropic.claude-sonnet-5",
        base_system_prompt="shared core\n\ncalling contract",
    )
    assert overrides["systemPrompt"] == [{"text": "shared core\n\ncalling contract"}]
    assert overrides["model"] == {"bedrockModelConfig": {"modelId": "us.anthropic.claude-opus-5"}}


def test_apply_overrides_falls_back_to_the_base_model() -> None:
    """An absent model_id uses the blueprint default rather than an empty model id."""
    overrides = apply_overrides(
        config={"max_iterations": 20},
        base_model="us.anthropic.claude-sonnet-5",
        base_system_prompt="core",
    )
    assert overrides["model"] == {"bedrockModelConfig": {"modelId": "us.anthropic.claude-sonnet-5"}}
    assert overrides["maxIterations"] == 20


def test_apply_overrides_omits_max_iterations_when_unset() -> None:
    """Sending maxIterations=0 would cap the agent at zero turns — omit the key instead."""
    overrides = apply_overrides(
        config={"max_iterations": 0}, base_model="m", base_system_prompt="core"
    )
    assert "maxIterations" not in overrides


def test_active_version_only_accepts_version_strings() -> None:
    """"none"/"" mean "run the blueprint defaults" — not a version named "none"."""
    assert active_version(ssm=_Ssm(value="v0007"), param_name="/p") == "v0007"
    assert active_version(ssm=_Ssm(value="none"), param_name="/p") is None
    assert active_version(ssm=_Ssm(value=" v0002 "), param_name="/p") == "v0002"


def test_active_version_is_fail_soft() -> None:
    """An unreadable pointer must degrade to defaults, not break every invocation."""
    assert active_version(ssm=_Ssm(value=None), param_name="/p") is None
    assert active_version(ssm=_Ssm(value="v1"), param_name="") is None


def test_load_config_returns_none_on_a_missing_document() -> None:
    """A dangling pointer degrades to defaults (the caller then uses the blueprint values)."""

    class _S3:
        def get_object(self, *, Bucket: str, Key: str) -> dict:  # noqa: N803
            raise RuntimeError(f"NoSuchKey: {Bucket}/{Key}")

    assert load_config(s3=_S3(), bucket="b", version="v0009") is None
