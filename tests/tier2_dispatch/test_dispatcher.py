"""Tests for the Tier-2 dispatcher: it must attach the token, and it must never duplicate work."""

import urllib.error

import pytest

from backend.tier2_dispatch import handler as dispatcher

_EVENT = {
    "agent_arn": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/r-1",
    "item": {"item_id": "i-1", "domain": "cash"},
    "session_id": "recon-i-1-abc",
    "taskToken": "tok-123",
}


def _fake_direct_client(captured: dict):
    class _C:
        def invoke_agent_runtime(self, **kwargs):
            captured.update(kwargs)
            return {"statusCode": 202}

    return _C()


def test_the_task_token_reaches_the_agent_on_the_payload(monkeypatch):
    """The token is how the agent knows to background the work. Lose it and the run blocks."""
    captured: dict = {}
    monkeypatch.setattr(dispatcher.boto3, "client", lambda _n, **_kw: _fake_direct_client(captured))
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)

    out = dispatcher.handle(_EVENT, None)

    assert out == {"dispatched": True, "statusCode": 202, "path": "direct"}
    import json

    assert json.loads(captured["payload"].decode())["taskToken"] == "tok-123"


def test_ingress_path_is_used_when_configured(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(dispatcher, "invoke_via_ingress", lambda **kw: (seen.update(kw), 202)[1])
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    out = dispatcher.handle(_EVENT, None)

    assert out["path"] == "ingress"
    assert seen["payload"]["taskToken"] == "tok-123"
    # A fixed short timeout, not a budget: there is no multi-minute read to size here.
    assert seen["timeout"] == dispatcher._DISPATCH_TIMEOUT_SECONDS


def test_a_non_timeout_ingress_failure_falls_back_to_direct(monkeypatch):
    """An HTTP status proves the request never ran, so a direct attempt duplicates nothing."""
    captured: dict = {}

    def _boom(**_kw):
        raise urllib.error.HTTPError("https://gw", 424, "Failed Dependency", {}, None)

    monkeypatch.setattr(dispatcher, "invoke_via_ingress", _boom)
    monkeypatch.setattr(dispatcher.boto3, "client", lambda _n, **_kw: _fake_direct_client(captured))
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    assert dispatcher.handle(_EVENT, None)["path"] == "direct"


def test_a_timeout_does_NOT_fall_back(monkeypatch):
    """The dispatch may have landed. A fallback would run a second investigation of one item."""

    def _times_out(**_kw):
        raise TimeoutError("read timed out")

    monkeypatch.setattr(dispatcher, "invoke_via_ingress", _times_out)
    monkeypatch.setattr(
        dispatcher.boto3,
        "client",
        lambda _n, **_kw: pytest.fail("fell back after a timeout — duplicates the investigation"),
    )
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    with pytest.raises(TimeoutError):
        dispatcher.handle(_EVENT, None)


def test_a_connect_phase_timeout_is_also_a_timeout(monkeypatch):
    """URLError-wrapped TimeoutError must not be mistaken for a delivery failure."""

    def _times_out(**_kw):
        raise urllib.error.URLError(TimeoutError("connect timed out"))

    monkeypatch.setattr(dispatcher, "invoke_via_ingress", _times_out)
    monkeypatch.setattr(
        dispatcher.boto3, "client", lambda _n, **_kw: pytest.fail("fell back after a timeout")
    )
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    with pytest.raises(urllib.error.URLError):
        dispatcher.handle(_EVENT, None)


@pytest.mark.parametrize("missing", ["agent_arn", "session_id", "taskToken", "item"])
def test_a_missing_key_raises_rather_than_no_opping(monkeypatch, missing):
    """The state is paused on a token only the agent can release; a silent no-op would hang it."""
    event = {k: v for k, v in _EVENT.items() if k != missing}
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)

    with pytest.raises(KeyError):
        dispatcher.handle(event, None)


def test_status_code_defaults_when_the_runtime_omits_it(monkeypatch):
    class _C:
        def invoke_agent_runtime(self, **_kw):
            return {}

    monkeypatch.setattr(dispatcher.boto3, "client", lambda _n, **_kw: _C())
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)

    assert dispatcher.handle(_EVENT, None)["statusCode"] == 200
