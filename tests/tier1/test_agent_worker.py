"""Test the async agent-worker Lambda: direct invoke, ingress invoke, and ingress fallback."""

import urllib.error

import pytest

from backend.tier1 import agent_worker


class _Ctx:
    """Minimal Lambda context — only ``get_remaining_time_in_millis`` is read by the worker."""

    def __init__(self, remaining_ms: int = 900_000) -> None:
        """:param remaining_ms: milliseconds left in the invocation."""
        self._remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self) -> int:
        """:returns: the remaining budget in milliseconds."""
        return self._remaining_ms


# A full ReconItem, as `invoke_agent._dispatch` always sends (`item.model_dump()`).
_EVENT = {
    "agent_arn": "arn:aws:...:runtime/recon",
    "item": {
        "item_id": "i-1",
        "domain": "cash",
        "sides": [{"name": "bank", "attributes": {"amount": "100.00"}}],
        "source_refs": [],
        "attributes": {},
        "tier": 1,
    },
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
    monkeypatch.setattr(
        agent_worker.boto3, "client", lambda _name, **_kw: _fake_direct_client(captured)
    )

    out = agent_worker.handle(_EVENT, _Ctx())

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
        agent_worker.boto3,
        "client",
        lambda _n, **_kw: (_ for _ in ()).throw(AssertionError("direct!")),
    )

    out = agent_worker.handle(_EVENT, _Ctx())

    assert out == {"statusCode": 200, "path": "ingress"}
    assert seen["gateway_url"] == "https://gw.example.com"
    assert seen["target"] == "recon-agent"
    assert seen["payload"]["item"]["item_id"] == "i-1"


def test_worker_falls_back_to_direct_when_ingress_fails(monkeypatch):
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    def _boom(**_kwargs):
        raise urllib.error.HTTPError("u", 403, "denied", {}, None)

    monkeypatch.setattr(agent_worker, "invoke_via_ingress", _boom)
    captured = {}
    monkeypatch.setattr(
        agent_worker.boto3, "client", lambda _n, **_kw: _fake_direct_client(captured)
    )

    out = agent_worker.handle(_EVENT, _Ctx())

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
        agent_worker.boto3,
        "client",
        lambda _n, **_kw: (_ for _ in ()).throw(AssertionError("runtime!")),
    )
    out = agent_worker.handle(_EVENT, _Ctx())
    assert out["path"] == "harness"
    assert out["outcome"] == "executed"


def test_both_backends_receive_the_tier1_keys(monkeypatch):
    """The worker forwards the item unchanged, so neither backend can lose the classification.

    The keys are stamped by the stream consumer before the case is opened, so this is a
    pass-through guard rather than a routing one: if someone starts rebuilding the payload per
    backend, the harness path is where a dropped key would go unnoticed.
    """
    event = {
        "agent_arn": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/r",
        "session_id": "recon-x",
        "item": {
            "item_id": "i-1",
            "domain": "cash",
            "sides": [
                {"name": "bank", "attributes": {"amount": "1.00"}},
                {"name": "ledger", "attributes": {"amount": "2.00"}},
            ],
            "attributes": {
                "tier1_escalation_reason": "tolerance_miss",
                "tier1_break_type": "record-match-review",
            },
        },
    }

    seen = {}

    def _capture_runtime(**kwargs):
        seen["runtime"] = kwargs["payload"]["item"]
        return 200

    monkeypatch.setattr(agent_worker, "_invoke_direct", _capture_runtime)
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "false")
    monkeypatch.setenv("AGENT_BACKEND", "runtime")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    agent_worker.handle(event, _Ctx())

    # Harness path — same event, only the selector differs.
    def _capture_harness(ev, _ctx):
        seen["harness"] = ev["item"]
        return {"ok": True}

    monkeypatch.setenv("AGENT_BACKEND", "harness")
    monkeypatch.setattr("backend.harness_agent.worker.handle", _capture_harness)
    agent_worker.handle(event, _Ctx())

    for path in ("runtime", "harness"):
        assert seen[path]["attributes"]["tier1_break_type"] == "record-match-review", path
        assert seen[path]["attributes"]["tier1_escalation_reason"] == "tolerance_miss", path


# --- Invocation budget: one investigation per item, never two ------------------------------------


def test_an_ingress_timeout_does_not_start_a_second_investigation(monkeypatch):
    """A timeout means the agent IS running; falling back would duplicate a multi-minute LLM run.

    The failure mode is not hypothetical: real investigations run 700-1100s, so any ingress timeout
    shorter than that makes EVERY run time out, fall back to a direct invoke, and stack up — the two
    invocations plus Lambda's async retries reach seven concurrent investigations of one item.

    :returns: None.
    """
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    def _times_out(**_kwargs):
        raise TimeoutError("The read operation timed out")

    monkeypatch.setattr(agent_worker, "invoke_via_ingress", _times_out)
    # Any direct invoke at all is the bug — the first investigation is still in flight.
    monkeypatch.setattr(
        agent_worker.boto3,
        "client",
        lambda _n, **_kw: (_ for _ in ()).throw(AssertionError("duplicated the investigation!")),
    )

    with pytest.raises(TimeoutError):
        agent_worker.handle(_EVENT, _Ctx())


def test_a_connect_phase_timeout_wrapped_in_urlerror_is_still_a_timeout(monkeypatch):
    """urllib reports a connect timeout as URLError(reason=TimeoutError), not as TimeoutError.

    Catching only the bare TimeoutError would let this one through to the fallback, which is the same
    duplication bug by a different code path.

    :returns: None.
    """
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")

    def _times_out(**_kwargs):
        raise urllib.error.URLError(TimeoutError("timed out"))

    monkeypatch.setattr(agent_worker, "invoke_via_ingress", _times_out)
    monkeypatch.setattr(
        agent_worker.boto3,
        "client",
        lambda _n, **_kw: (_ for _ in ()).throw(AssertionError("duplicated the investigation!")),
    )

    with pytest.raises(urllib.error.URLError):
        agent_worker.handle(_EVENT, _Ctx())


def test_a_gateway_http_error_still_falls_back(monkeypatch):
    """The fallback must survive: an HTTPError means the gateway answered, so nothing is in flight.

    Guards against over-correcting the timeout fix into "never fall back", which would strand every
    escalated item behind a gateway misconfiguration.

    :returns: None.
    """
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")
    # 424 Failed Dependency is the status this gateway was actually observed returning.
    monkeypatch.setattr(
        agent_worker,
        "invoke_via_ingress",
        lambda **_k: (_ for _ in ()).throw(
            urllib.error.HTTPError("u", 424, "failed dependency", {}, None)
        ),
    )
    captured = {}
    monkeypatch.setattr(
        agent_worker.boto3, "client", lambda _n, **_kw: _fake_direct_client(captured)
    )

    assert agent_worker.handle(_EVENT, _Ctx())["path"] == "direct"


def test_the_ingress_timeout_is_the_remaining_lambda_budget(monkeypatch):
    """The timeout must track the live deadline, not a constant that outlives the Lambda config.

    A hard-coded value is correct only for whichever Lambda timeout it was written against, and it
    becomes a silent under-estimate the next time that timeout is raised. Deriving it from the
    context makes the two impossible to desynchronise.

    :returns: None.
    """
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")
    seen = {}
    monkeypatch.setattr(
        agent_worker, "invoke_via_ingress", lambda **kwargs: (seen.update(kwargs), 200)[1]
    )

    agent_worker.handle(_EVENT, _Ctx(remaining_ms=900_000))

    # 900s budget minus the reporting reserve — comfortably longer than a real investigation.
    assert seen["timeout"] == 900.0 - agent_worker._BUDGET_RESERVE_SECONDS
    assert seen["timeout"] > 600


def test_the_direct_client_never_retries_a_read_timeout(monkeypatch):
    """botocore retries ReadTimeoutError by default; here that means a second full investigation.

    The read timeout is not evidence the request failed — the runtime is still working — so a retry
    can only duplicate cost. Asserted on the client config because the retry happens inside botocore
    where a behavioural test would need a live socket.

    :returns: None.
    """
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    configs = []

    def _client(_name, **kwargs):
        configs.append(kwargs.get("config"))
        return _fake_direct_client({})

    monkeypatch.setattr(agent_worker.boto3, "client", _client)

    agent_worker.handle(_EVENT, _Ctx(remaining_ms=900_000))

    config = configs[0]
    assert config.retries["max_attempts"] == 1  # 1 attempt total = no retry
    assert config.read_timeout == 900.0 - agent_worker._BUDGET_RESERVE_SECONDS


def test_a_nearly_exhausted_budget_still_yields_a_positive_timeout():
    """A zero or negative timeout means "no timeout" to urllib/botocore — the opposite of intended.

    :returns: None.
    """
    assert agent_worker._remaining_budget_seconds(_Ctx(remaining_ms=100)) == 1.0


# --- Escalating a dead investigation to FAILED ----------------------------------------------------


class _SpyStore:
    """Records ``mark_failed`` calls in place of a real CaseStore."""

    calls: list[tuple[str, str]] = []

    def __init__(self, table: str, audit: str) -> None:
        """:param table: cases table name. :param audit: audit table name."""
        self.table = table

    def mark_failed(self, item_id: str, *, reason: str) -> bool:
        """Record the call and report success.

        :param item_id: the case key.
        :param reason: the failure text.
        :returns: True, as a real store does when the case was IN_PROGRESS.
        """
        _SpyStore.calls.append((item_id, reason))
        return True


def _spy_store(monkeypatch) -> list[tuple[str, str]]:
    """Patch ``CaseStore`` with :class:`_SpyStore` and return the (shared) call list.

    ``_record_failure`` imports CaseStore lazily from ``backend.recon_core.cases``, so the patch has
    to land on that module rather than on an attribute of the worker.

    :param monkeypatch: pytest's monkeypatch fixture.
    :returns: the list that receives ``(item_id, reason)`` tuples.
    """
    _SpyStore.calls = []
    monkeypatch.setattr("backend.recon_core.cases.CaseStore", _SpyStore)
    return _SpyStore.calls


def test_a_dead_investigation_marks_the_case_failed_and_still_raises(monkeypatch):
    """A non-timeout failure must escalate the case AND remain an error for Lambda's metrics.

    Without the escalation the item sat in IN_PROGRESS forever: only the agent writes the PROPOSED
    row, so an invocation that dies leaves a queue entry that will never advance and gives an analyst
    nothing to distinguish "still thinking" from "died 40 minutes ago". Re-raising is the other half
    — swallowing the error would hide the failure from the function's own error rate.

    :returns: None.
    """
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    monkeypatch.setenv("AGENT_BACKEND", "runtime")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    calls = _spy_store(monkeypatch)
    monkeypatch.setattr(
        agent_worker,
        "_invoke_direct",
        lambda **_k: (_ for _ in ()).throw(RuntimeError("Received error (500) from runtime")),
    )

    with pytest.raises(RuntimeError):
        agent_worker.handle(_EVENT, _Ctx())

    assert len(calls) == 1
    item_id, reason = calls[0]
    assert item_id == "i-1"
    # The exception TYPE belongs in the stored reason: "RuntimeError" vs "ThrottlingException" is
    # what tells the analyst whether a retry has any chance of behaving differently.
    assert reason == "RuntimeError: Received error (500) from runtime"


def test_a_timeout_does_not_mark_the_case_failed(monkeypatch):
    """A timeout means the investigation is still running server-side and will persist its own result.

    Marking it FAILED would be a false verdict, and the retry it invites would start a SECOND
    multi-minute investigation of the same item — the same duplication the ingress path refuses to
    cause by falling back.

    :returns: None.
    """
    monkeypatch.setenv("USE_INGRESS_GATEWAY", "true")
    monkeypatch.setenv("INGRESS_GATEWAY_URL", "https://gw.example.com")
    calls = _spy_store(monkeypatch)
    monkeypatch.setattr(
        agent_worker,
        "invoke_via_ingress",
        lambda **_k: (_ for _ in ()).throw(TimeoutError("The read operation timed out")),
    )

    with pytest.raises(TimeoutError):
        agent_worker.handle(_EVENT, _Ctx())

    assert calls == []


def test_a_harness_backend_failure_is_escalated_too(monkeypatch):
    """The FAILED escalation wraps dispatch, so it covers both backends, not just the runtime one.

    The harness worker raises on failure exactly as the runtime path does; if the guard sat inside
    the runtime branch, flipping AGENT_BACKEND would silently reintroduce the stranded-case bug.

    :returns: None.
    """
    monkeypatch.setenv("AGENT_BACKEND", "harness")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    calls = _spy_store(monkeypatch)
    monkeypatch.setattr(
        "backend.harness_agent.worker.handle",
        lambda _ev, _ctx: (_ for _ in ()).throw(ValueError("harness stream died")),
    )

    with pytest.raises(ValueError):
        agent_worker.handle(_EVENT, _Ctx())

    assert calls == [("i-1", "ValueError: harness stream died")]


def test_an_error_status_returned_rather_than_raised_is_escalated(monkeypatch):
    """A failing status that arrives as a RETURN value strands the case just as an exception would."""
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    monkeypatch.setenv("AGENT_BACKEND", "runtime")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    calls = _spy_store(monkeypatch)
    monkeypatch.setattr(agent_worker, "_invoke_direct", lambda **_k: 502)

    out = agent_worker.handle(_EVENT, _Ctx())

    assert out == {"statusCode": 502, "path": "direct"}
    assert calls == [("i-1", "agent invocation returned HTTP 502")]


def test_a_successful_invocation_never_touches_the_case(monkeypatch):
    """The agent owns the case row on the happy path — the worker must not write to it at all."""
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    monkeypatch.setenv("AGENT_BACKEND", "runtime")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    calls = _spy_store(monkeypatch)
    monkeypatch.setattr(agent_worker, "_invoke_direct", lambda **_k: 200)

    assert agent_worker.handle(_EVENT, _Ctx()) == {"statusCode": 200, "path": "direct"}
    assert calls == []


def test_a_failure_while_recording_the_failure_does_not_mask_the_real_error(monkeypatch):
    """The original exception is the diagnosis; a DynamoDB error while recording must not replace it.

    :returns: None.
    """
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    monkeypatch.setenv("AGENT_BACKEND", "runtime")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    monkeypatch.setattr(
        "backend.recon_core.cases.CaseStore",
        lambda **_k: (_ for _ in ()).throw(RuntimeError("dynamodb unreachable")),
    )
    monkeypatch.setattr(
        agent_worker,
        "_invoke_direct",
        lambda **_k: (_ for _ in ()).throw(ValueError("the real error")),
    )

    with pytest.raises(ValueError, match="the real error"):
        agent_worker.handle(_EVENT, _Ctx())


def test_an_event_with_no_item_id_cannot_mark_a_case_failed(monkeypatch):
    """No key means no case to escalate; the worker logs and re-raises instead of guessing one."""
    monkeypatch.delenv("USE_INGRESS_GATEWAY", raising=False)
    monkeypatch.setenv("AGENT_BACKEND", "runtime")
    monkeypatch.delenv("AGENT_BACKEND_PARAM", raising=False)
    calls = _spy_store(monkeypatch)
    monkeypatch.setattr(
        agent_worker, "_invoke_direct", lambda **_k: (_ for _ in ()).throw(ValueError("boom"))
    )
    event = {**_EVENT, "item": {}}

    with pytest.raises(ValueError):
        agent_worker.handle(event, _Ctx())

    assert calls == []
