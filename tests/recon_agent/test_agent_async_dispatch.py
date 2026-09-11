"""Tests for the async (task-token) invocation mode and the FAILED-on-death contract.

The router itself is thin, but three of its properties are load-bearing and none of them are obvious
from reading it:

* a token means "return NOW" — if the entrypoint ever awaits the investigation, the caller keeps
  paying for the wait and the whole change is pointless;
* a dead run must leave a FAILED case behind, because only this container writes the PROPOSED row;
* a failed callback must not undo a persisted proposal.
"""

import asyncio

import pytest

import agent


class _FakeCases:
    """Records mark_failed calls. `result` is what mark_failed returns; set an exception to raise."""

    def __init__(self, result: bool = True, raises: BaseException | None = None):
        self.calls: list[tuple[str, str]] = []
        self._result = result
        self._raises = raises

    def mark_failed(self, item_id: str, *, reason: str) -> bool:
        self.calls.append((item_id, reason))
        if self._raises is not None:
            raise self._raises
        return self._result


@pytest.fixture
def _no_flush(monkeypatch):
    """Tracing is irrelevant here and needs no collector."""
    monkeypatch.setattr(agent, "flush_traces", lambda: None)


def _payload(item_id: str = "i-1", token: str = "") -> dict:
    out: dict = {"item": {"item_id": item_id, "domain": "cash"}}
    if token:
        out["taskToken"] = token
    return out


# ---------------------------------------------------------------------------------
# The router
# ---------------------------------------------------------------------------------


def test_no_token_runs_synchronously_and_returns_the_result(monkeypatch, _no_flush):
    """Without a token the old behaviour is unchanged: the result comes back in the response."""
    monkeypatch.setattr(agent, "_investigate_body", _async_return({"status": "PROPOSED"}))

    out = asyncio.run(agent.handler(_payload(), None))

    assert out == {"status": "PROPOSED"}


def test_token_returns_accepted_without_awaiting_the_investigation(monkeypatch, _no_flush):
    """A token means release the caller immediately.

    The investigation is made to block until released, so if `handler` awaited it this test would
    hang rather than fail — which is the point: any regression to a blocking entrypoint is loud.
    """
    started = asyncio.Event()
    release = asyncio.Event()

    async def _blocks(payload):
        started.set()
        await release.wait()
        return {"status": "PROPOSED"}

    monkeypatch.setattr(agent, "_investigate_body", _blocks)
    sent: list = []
    monkeypatch.setattr(agent, "_send_task_success", lambda **kw: sent.append(kw))

    async def _drive():
        out = await agent.handler(_payload(token="tok"), None)
        # Returned while the background task is still blocked on `release`.
        await started.wait()
        assert not sent, "callback fired before the investigation finished"
        release.set()
        await asyncio.sleep(0)  # let the background task run to completion
        await asyncio.sleep(0)
        return out

    out = asyncio.run(_drive())

    assert out == {"status": "accepted"}
    assert [kw["task_token"] for kw in sent] == ["tok"]


def test_async_success_signals_the_token_with_the_result(monkeypatch, _no_flush):
    monkeypatch.setattr(agent, "_investigate_body", _async_return({"status": "PROPOSED"}))
    sent: list = []
    monkeypatch.setattr(agent, "_send_task_success", lambda **kw: sent.append(kw))

    asyncio.run(agent._investigate_async(_payload(token="tok"), "tok"))

    assert sent == [{"task_token": "tok", "result": {"status": "PROPOSED"}}]


def test_async_failure_signals_failure_and_does_not_signal_success(monkeypatch, _no_flush):
    boom = RuntimeError("throttled")
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(boom))
    monkeypatch.setattr(agent, "_record_failure", lambda **kw: None)
    failures: list = []
    monkeypatch.setattr(agent, "_send_task_failure", lambda **kw: failures.append(kw))
    monkeypatch.setattr(
        agent, "_send_task_success", lambda **kw: pytest.fail("success signalled on a dead run")
    )

    asyncio.run(agent._investigate_async(_payload(token="tok"), "tok"))

    assert failures == [{"task_token": "tok", "exc": boom}]


# ---------------------------------------------------------------------------------
# FAILED on death
# ---------------------------------------------------------------------------------


def test_a_dead_run_marks_the_case_failed_and_reraises(monkeypatch, _no_flush):
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(RuntimeError("throttled")))
    cases = _FakeCases()
    monkeypatch.setattr(agent, "CaseStore", lambda **_kw: cases)

    with pytest.raises(RuntimeError, match="throttled"):
        asyncio.run(agent._investigate(_payload()))

    assert cases.calls == [("i-1", "RuntimeError: throttled")]


def test_a_successful_run_never_marks_the_case_failed(monkeypatch, _no_flush):
    monkeypatch.setattr(agent, "_investigate_body", _async_return({"status": "PROPOSED"}))
    cases = _FakeCases()
    monkeypatch.setattr(agent, "CaseStore", lambda **_kw: cases)

    asyncio.run(agent._investigate(_payload()))

    assert cases.calls == []


def test_mark_failed_raising_does_not_mask_the_original_error(monkeypatch, _no_flush):
    """The diagnosis must survive. A DynamoDB error here would replace the real cause."""
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(RuntimeError("throttled")))
    monkeypatch.setattr(
        agent, "CaseStore", lambda **_kw: _FakeCases(raises=ValueError("ddb exploded"))
    )

    with pytest.raises(RuntimeError, match="throttled"):
        asyncio.run(agent._investigate(_payload()))


def test_no_case_row_is_survivable(monkeypatch, _no_flush):
    """`mark_failed` raises KeyError when the row is absent; that must not become the reported error."""
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(RuntimeError("throttled")))
    monkeypatch.setattr(agent, "CaseStore", lambda **_kw: _FakeCases(raises=KeyError("i-1")))

    with pytest.raises(RuntimeError, match="throttled"):
        asyncio.run(agent._investigate(_payload()))


def test_a_payload_with_no_item_id_skips_the_write(monkeypatch, _no_flush):
    """Nothing to key the write on, so it must not be attempted — and must not crash."""
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(RuntimeError("bad payload")))
    monkeypatch.setattr(
        agent, "CaseStore", lambda **_kw: pytest.fail("CaseStore built with no item_id")
    )

    with pytest.raises(RuntimeError, match="bad payload"):
        asyncio.run(agent._investigate({"item": {}}))


def test_a_case_no_longer_in_progress_is_left_alone(monkeypatch, _no_flush):
    """mark_failed returning False means a proposal landed first. That result outranks the error."""
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(RuntimeError("late failure")))
    cases = _FakeCases(result=False)
    monkeypatch.setattr(agent, "CaseStore", lambda **_kw: cases)

    with pytest.raises(RuntimeError, match="late failure"):
        asyncio.run(agent._investigate(_payload()))

    assert len(cases.calls) == 1  # attempted once, refused, not retried


# ---------------------------------------------------------------------------------
# Callbacks never raise
# ---------------------------------------------------------------------------------


def test_send_task_success_swallows_a_dead_token(monkeypatch):
    """TaskTimedOut is expected, not exceptional: the state already gave up."""

    class _TaskTimedOut(Exception):
        pass

    _TaskTimedOut.__name__ = "TaskTimedOut"

    monkeypatch.setattr(agent.boto3, "client", _client_raising(_TaskTimedOut("gone")))

    agent._send_task_success(task_token="tok", result={"ok": True})  # must not raise


def test_send_task_success_swallows_any_transport_error(monkeypatch):
    """A failed callback must not undo a proposal that is already persisted."""
    monkeypatch.setattr(agent.boto3, "client", _client_raising(RuntimeError("network")))

    agent._send_task_success(task_token="tok", result={"ok": True})  # must not raise


def test_send_task_failure_swallows_transport_errors(monkeypatch):
    monkeypatch.setattr(agent.boto3, "client", _client_raising(RuntimeError("network")))

    agent._send_task_failure(task_token="tok", exc=ValueError("original"))  # must not raise


def test_send_task_failure_truncates_an_enormous_cause(monkeypatch):
    """The API rejects a `cause` over 32768 characters outright, which would lose the signal."""
    seen: dict = {}
    monkeypatch.setattr(agent.boto3, "client", _client_capturing(seen))

    agent._send_task_failure(task_token="tok", exc=ValueError("x" * 50_000))

    assert len(seen["cause"]) <= 32_000


# ---------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------


def _async_return(value):
    async def _f(_payload):
        return value

    return _f


def _async_raise(exc):
    async def _f(_payload):
        raise exc

    return _f


def _client_raising(exc):
    class _C:
        def send_task_success(self, **_kw):
            raise exc

        def send_task_failure(self, **_kw):
            raise exc

    return lambda _name, **_kw: _C()


def _client_capturing(seen: dict):
    class _C:
        def send_task_failure(self, **kw):
            seen.update(kw)

        def send_task_success(self, **kw):
            seen.update(kw)

    return lambda _name, **_kw: _C()
