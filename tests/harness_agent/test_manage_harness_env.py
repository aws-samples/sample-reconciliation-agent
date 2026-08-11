"""Harness provisioner: environmentVariables parsing + Create/Update wiring.

``manage_harness.py`` lives under ``infra/modules/recon-agent-harness/`` (it is driven by a
Terraform provisioner, not imported by the app), so it is loaded here by path.
"""

import importlib.util
import json
import pathlib
import sys

import pytest

_SCRIPT = (
    pathlib.Path(__file__).resolve().parents[2]
    / "infra"
    / "modules"
    / "recon-agent-harness"
    / "manage_harness.py"
)


def _load():
    """Load manage_harness.py as a module from its path.

    :returns: the imported module object.
    """
    spec = importlib.util.spec_from_file_location("manage_harness_under_test", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def mh():
    """The loaded provisioner module.

    :returns: the manage_harness module.
    """
    return _load()


class _FakeHarnessConfig:
    """Stand-in for the blueprint harness_config module."""

    ALLOWED_TOOLS = ["submit_proposal"]
    DEFAULT_MAX_ITERATIONS = 12
    DEFAULT_IDLE_SECONDS = 900
    DEFAULT_MAX_LIFETIME_SECONDS = 3600

    @staticmethod
    def tools(gateway_arn: str) -> list:
        """Return a minimal tools list.

        :param gateway_arn: egress gateway ARN.
        :returns: one gateway tool entry.
        """
        return [{"gateway": {"gatewayArn": gateway_arn}}]


@pytest.fixture()
def base_env(monkeypatch):
    """Set the minimum env _config() requires, with no harness env vars.

    :returns: None.
    """
    monkeypatch.setenv("EXECUTION_ROLE_ARN", "arn:aws:iam::1:role/harness")
    monkeypatch.setenv("GATEWAY_ARN", "arn:aws:bedrock-agentcore:us-east-1:1:gateway/gw")
    monkeypatch.delenv("HARNESS_ENV_JSON", raising=False)
    monkeypatch.delenv("SUBNETS", raising=False)
    monkeypatch.delenv("SKILLS_S3_URIS", raising=False)


def test_unset_env_json_yields_no_variables(mh, base_env):
    """No HARNESS_ENV_JSON → empty map (and, below, the key is omitted from the config)."""
    assert mh._environment_variables() == {}


def test_parses_object_and_stringifies_scalars(mh, monkeypatch):
    """A JSON object is parsed; non-string scalars are coerced to strings for the API."""
    monkeypatch.setenv(
        "HARNESS_ENV_JSON",
        json.dumps({"OTEL_PYTHON_EXCLUDED_URLS": "/ping,/health", "RETRIES": 3, "FLAG": True}),
    )
    assert mh._environment_variables() == {
        "OTEL_PYTHON_EXCLUDED_URLS": "/ping,/health",
        "RETRIES": "3",
        "FLAG": "True",
    }


@pytest.mark.parametrize(
    ("raw", "match"),
    [
        ("{not json", "not valid JSON"),
        ('["a", "b"]', "must be a JSON object"),
        ('{"OTEL": {"nested": 1}}', "must be a scalar"),
        ('{"OTEL": ["a"]}', "must be a scalar"),
    ],
)
def test_malformed_env_json_fails_loudly(mh, monkeypatch, raw, match):
    """Bad input raises instead of silently shipping a harness with no observability config."""
    monkeypatch.setenv("HARNESS_ENV_JSON", raw)
    with pytest.raises(ValueError, match=match):
        mh._environment_variables()


def test_config_omits_the_key_when_there_are_no_variables(mh, base_env, monkeypatch):
    """An empty map must not become ``environmentVariables={}`` in the API call."""
    monkeypatch.setattr(mh, "_harness_config", lambda: _FakeHarnessConfig)
    assert "environmentVariables" not in mh._config()


def test_config_includes_the_variables_when_present(mh, base_env, monkeypatch):
    """Non-empty variables ride along in the shared Create/Update config."""
    monkeypatch.setattr(mh, "_harness_config", lambda: _FakeHarnessConfig)
    monkeypatch.setenv("HARNESS_ENV_JSON", json.dumps({"OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS": "session.id"}))
    assert mh._config()["environmentVariables"] == {"OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS": "session.id"}


class _Ctl:
    """Minimal bedrock-agentcore-control double recording the calls made."""

    def __init__(self, *, existing: bool) -> None:
        """Record whether a harness already exists.

        :param existing: True to make ListHarnesses return a match (update path).
        """
        self._existing = existing
        self.created: dict = {}
        self.updated: dict = {}

    def list_harnesses(self) -> dict:
        """Return one harness when configured to exist, else none.

        :returns: a ListHarnesses-shaped dict.
        """
        return {"harnesses": [{"harnessName": "recon_dev_harness", "harnessId": "h-1"}]
                if self._existing else []}

    def create_harness(self, **kwargs) -> dict:
        """Record a CreateHarness call.

        :param kwargs: the API arguments.
        :returns: a CreateHarness-shaped dict.
        """
        self.created = kwargs
        return {"harnessId": "h-1"}

    def update_harness(self, **kwargs) -> dict:
        """Record an UpdateHarness call.

        :param kwargs: the API arguments.
        :returns: an empty dict.
        """
        self.updated = kwargs
        return {}

    def get_harness(self, *, harnessId: str) -> dict:
        """Return a READY harness.

        :param harnessId: the harness id.
        :returns: a GetHarness-shaped dict.
        """
        return {"harness": {"status": "READY", "arn": f"arn:aws:...:harness/{harnessId}"}}


def test_environment_variables_are_sent_on_create_and_update(mh, base_env, monkeypatch):
    """Both provisioning paths carry the variables — update_harness only sends what it lists."""
    monkeypatch.setattr(mh, "_harness_config", lambda: _FakeHarnessConfig)
    env = {"OTEL_PYTHON_DISABLED_INSTRUMENTATIONS": "urllib3,requests"}
    monkeypatch.setenv("HARNESS_ENV_JSON", json.dumps(env))

    fresh = _Ctl(existing=False)
    mh.create_or_update(fresh, "recon_dev_harness")
    assert fresh.created["environmentVariables"] == env

    existing = _Ctl(existing=True)
    mh.create_or_update(existing, "recon_dev_harness")
    assert existing.updated["environmentVariables"] == env


def test_update_omits_the_key_when_no_variables_are_configured(mh, base_env, monkeypatch):
    """With none configured, update must not send an empty map that would wipe existing ones."""
    monkeypatch.setattr(mh, "_harness_config", lambda: _FakeHarnessConfig)
    existing = _Ctl(existing=True)
    mh.create_or_update(existing, "recon_dev_harness")
    assert "environmentVariables" not in existing.updated


class _DeletingCtl(_Ctl):
    """A control-plane double whose harness is DELETING for the first ``lingers`` list calls."""

    def __init__(self, *, lingers: int) -> None:
        """Record how many ListHarnesses calls still show the dying harness.

        :param lingers: number of list calls that return the DELETING harness.
        """
        super().__init__(existing=True)
        self._lingers = lingers
        self.list_calls = 0

    def list_harnesses(self) -> dict:
        """Return the DELETING harness until it has lingered long enough, then nothing.

        :returns: a ListHarnesses-shaped dict.
        """
        self.list_calls += 1
        if self.list_calls <= self._lingers:
            return {"harnesses": [{"harnessName": "recon_dev_harness", "harnessId": "h-old",
                                   "status": "DELETING"}]}
        return {"harnesses": []}


def test_a_deleting_harness_is_waited_out_then_recreated(mh, base_env, monkeypatch):
    """Replace = destroy-then-create: never update (or collide with) a harness mid-delete."""
    monkeypatch.setattr(mh, "_harness_config", lambda: _FakeHarnessConfig)
    monkeypatch.setattr(mh.time, "sleep", lambda _s: None)
    ctl = _DeletingCtl(lingers=3)

    mh.create_or_update(ctl, "recon_dev_harness")

    assert ctl.updated == {}, "must not UpdateHarness a harness that is being deleted"
    assert ctl.created["harnessName"] == "recon_dev_harness"
    assert ctl.list_calls > 3, "should have polled until the old harness disappeared"


def test_wait_gone_fails_loudly_when_the_harness_never_disappears(mh):
    """A stuck delete must raise rather than create a second harness with the same name."""
    ctl = _DeletingCtl(lingers=10_000)
    with pytest.raises(RuntimeError, match="still exists after delete"):
        mh._wait_gone(ctl, "recon_dev_harness", sleeper=lambda _s: None)
