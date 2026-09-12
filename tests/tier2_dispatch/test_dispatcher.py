"""Tests for the Tier-2 dispatcher: it must attach the token, and it must never duplicate work."""

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


def test_dispatch_is_always_direct_even_when_the_ingress_env_is_set(monkeypatch):
    """The ingress gateway CANNOT serve this path -- it holds the connection until the runtime session
    finishes, so the container's immediate {"status": "accepted"} never arrives and the Task times out
    while the investigation it started goes on to succeed. Observed 2026-09-11.

    Asserted with the env deliberately set, because "we just won't configure it" is not a guarantee.
    """
    captured: dict = {}
    monkeypatch.setattr(dispatcher.boto3, "client", lambda _n, **_kw: _fake_direct_client(captured))
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    assert dispatcher.handle(_EVENT, None)["path"] == "direct"
    assert captured, "did not call InvokeAgentRuntime"
