"""Test the async agent-worker Lambda: direct invoke, ingress invoke, and ingress fallback."""

import urllib.error


from backend.tier1 import agent_worker

_EVENT = {
    "agent_arn": "arn:aws:...:runtime/recon",
    "item": {"item_id": "i-1"},
    "session_id": "recon-i-1-" + "a" * 40,
}


def _fake_direct_client(captured):
    class _FakeClient:
        def invoke_agent_runtime(self, **kwargs):
            captured.update(kwargs)
            return {"statusCode": 200}

    return _FakeClient()


def test_worker_invokes_runtime_directly_when_ingress_disabled(monkeypatch):
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    captured = {}
    monkeypatch.setattr(agent_worker.boto3, "client", lambda _name: _fake_direct_client(captured))

    out = agent_worker.handle(_EVENT, None)

    assert out == {"statusCode": 200, "path": "direct"}
    assert captured["agentRuntimeArn"] == "arn:aws:...:runtime/recon"
    assert captured["runtimeSessionId"].startswith("recon-i-1-")


def test_worker_invokes_via_ingress_when_enabled(monkeypatch):
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")
    monkeypatch.setenv("INGRESS_TARGET_NAME", "recon-agent")
    seen = {}

    def _fake_invoke(**kwargs):
        seen.update(kwargs)
        return 200

    monkeypatch.setattr(agent_worker, "invoke_via_ingress", _fake_invoke)
    # A direct call would blow up — prove the ingress path is taken, not the fallback.
    monkeypatch.setattr(
        agent_worker.boto3, "client", lambda _n: (_ for _ in ()).throw(AssertionError("direct!"))
    )

    out = agent_worker.handle(_EVENT, None)

    assert out == {"statusCode": 200, "path": "ingress"}
    assert seen["gateway_url"] == "https://gw.example.com"
    assert seen["target"] == "recon-agent"
    assert seen["payload"] == {"item": {"item_id": "i-1"}}


def test_worker_falls_back_to_direct_when_ingress_fails(monkeypatch):
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    def _boom(**_kwargs):
        raise urllib.error.HTTPError("u", 403, "denied", {}, None)

    monkeypatch.setattr(agent_worker, "invoke_via_ingress", _boom)
    captured = {}
    monkeypatch.setattr(agent_worker.boto3, "client", lambda _n: _fake_direct_client(captured))

    out = agent_worker.handle(_EVENT, None)

    # Fell back to a direct runtime invoke — an item is never stranded by a gateway failure.
    assert out == {"statusCode": 200, "path": "direct"}
    assert captured["agentRuntimeArn"] == "arn:aws:...:runtime/recon"


def test_worker_routes_to_harness_when_backend_is_harness(monkeypatch):
    monkeypatch.setenv("AGENT_BACKEND", "harness")
    import backend.harness_agent.worker as harness_worker

    monkeypatch.setattr(
        harness_worker, "handle", lambda ev, ctx: {"outcome": "executed", "item_id": "i-1"}
    )
    # A runtime invoke would blow up — prove the harness path is taken, not the runtime path.
    monkeypatch.setattr(
        agent_worker.boto3, "client", lambda _n: (_ for _ in ()).throw(AssertionError("runtime!"))
    )
    out = agent_worker.handle(_EVENT, None)
    assert out["path"] == "harness"
    assert out["outcome"] == "executed"
