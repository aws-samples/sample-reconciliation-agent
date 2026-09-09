"""Tests for the live Tier-2 model selection read.

The behaviour worth pinning is the fail direction. This read deliberately fails SOFT to the deployed
default, which is the opposite of ``auto_resolve.get_threshold`` in the same package: there is no
safe-by-omission model, so failing hard would strand every escalation on a transient SSM error.
"""

import logging

import pytest

from backend.recon_core.model_select import ALLOWED_MODEL_IDS, get_agent_model_id

DEFAULT = "us.anthropic.claude-sonnet-5"
SELECTED = "global.anthropic.claude-opus-5"


class _FakeSsm:
    """Stands in for the SSM client, returning one value or raising."""

    def __init__(self, value=None, *, raises: Exception | None = None):
        self._value = value
        self._raises = raises
        self.requests: list[str] = []

    def get_parameter(self, *, Name: str) -> dict:  # noqa: N803 - boto3's parameter name
        self.requests.append(Name)
        if self._raises is not None:
            raise self._raises
        return {"Parameter": {"Value": self._value}}


def test_an_allowed_selection_is_honoured():
    ssm = _FakeSsm(SELECTED)
    assert get_agent_model_id("/recon-dev/agent-model-id", default=DEFAULT, ssm=ssm) == SELECTED
    assert ssm.requests == ["/recon-dev/agent-model-id"]


def test_surrounding_whitespace_does_not_defeat_the_allowlist():
    """A value pasted into the console arrives with a trailing newline more often than not."""
    ssm = _FakeSsm(f"  {SELECTED}\n")
    assert get_agent_model_id("/p", default=DEFAULT, ssm=ssm) == SELECTED


def test_an_unwired_parameter_name_skips_the_read_entirely():
    """No parameter configured is the zero-config case, and it must not cost an SSM call."""
    ssm = _FakeSsm(SELECTED)
    assert get_agent_model_id("", default=DEFAULT, ssm=ssm) == DEFAULT
    assert ssm.requests == []


def test_an_empty_value_falls_back_silently(caplog):
    """The pre-seed state is normal, not a fault, so it earns no warning to chase."""
    with caplog.at_level(logging.WARNING):
        assert get_agent_model_id("/p", default=DEFAULT, ssm=_FakeSsm("")) == DEFAULT
    assert caplog.records == []


def test_an_unreadable_parameter_falls_back_and_says_so(caplog):
    """Fail SOFT, and loudly enough to diagnose.

    Failing hard here would stall every escalation on an SSM blip; there is no such thing as
    reconciling with no model, so 'refuse to run' is not the safe option it is for the auto-resolve
    threshold.
    """
    ssm = _FakeSsm(raises=RuntimeError("ParameterNotFound"))
    with caplog.at_level(logging.WARNING):
        assert get_agent_model_id("/p", default=DEFAULT, ssm=ssm) == DEFAULT
    assert any("falling back to the deployed default" in r.message for r in caplog.records)


def test_a_value_outside_the_allowlist_is_refused_and_named(caplog):
    """The allowlist is enforced on READ, because a hand-edited parameter never passes the BFF.

    Letting an unknown id through would surface as a Bedrock error on every single invocation rather
    than as the configuration problem it is.
    """
    ssm = _FakeSsm("us.anthropic.claude-nonexistent-9")
    with caplog.at_level(logging.WARNING):
        assert get_agent_model_id("/p", default=DEFAULT, ssm=ssm) == DEFAULT
    # The rejected value has to appear in the log, not just the fact of a rejection: the operator who
    # set it is otherwise left watching a saved selection quietly have no effect.
    assert any("not in the allowlist" in r.getMessage() for r in caplog.records)
    assert any("claude-nonexistent-9" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("model_id", ALLOWED_MODEL_IDS)
def test_every_allowlisted_id_round_trips(model_id):
    assert get_agent_model_id("/p", default=DEFAULT, ssm=_FakeSsm(model_id)) == model_id


def test_the_allowlist_covers_both_endpoints_for_every_family():
    """Each family is offered on both endpoints, since the choice is data residency, not capability.

    A family present on only one endpoint would silently make the endpoint control do nothing for it.
    """
    families = {mid.split(".", 1)[1] for mid in ALLOWED_MODEL_IDS}
    for family in families:
        assert f"us.{family}" in ALLOWED_MODEL_IDS
        assert f"global.{family}" in ALLOWED_MODEL_IDS
    assert len(ALLOWED_MODEL_IDS) == len(families) * 2


def test_the_allowlist_has_no_duplicates():
    assert len(set(ALLOWED_MODEL_IDS)) == len(ALLOWED_MODEL_IDS)
