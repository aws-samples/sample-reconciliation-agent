"""Tests for the async (task-token) invocation mode and the FAILED-on-death contract.

The router itself is thin, but three of its properties are load-bearing and none of them are obvious
from reading it:

* a token means "return NOW" — if the entrypoint ever waits on the investigation, the caller keeps
  paying for the wait and the whole change is pointless. This one bit through once already: an
  `asyncio.create_task` version passed a test written with asyncio primitives and still held the
  connection open for 152 seconds in the real container, because the SDK awaits whatever the
  entrypoint schedules on its worker loop. So the blocking here is deliberately a THREADING event —
  a version that keeps the work on the caller's loop cannot pass it;
* a dead run must leave a FAILED case behind, because only this container writes the PROPOSED row;
* a failed callback must not undo a persisted proposal.
"""

import asyncio
import threading

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


# Long enough that a loaded CI runner does not flake, short enough that a genuine deadlock fails the
# suite instead of hanging it.
_WAIT_SECONDS = 5.0


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


def test_token_returns_accepted_while_the_investigation_is_still_running(monkeypatch, _no_flush):
    """A token means release the caller immediately, with the work genuinely still in flight.

    Two things give this teeth against the create_task regression it exists for:

    * the investigation blocks on a **threading** event, so it cannot be running on the loop the
      entrypoint returns to — only a real thread can make progress here;
    * ``asyncio.run`` closes that loop on return, which discards any task still pending on it. So a
      create_task version never fires the callback and the last assertion fails.
    """
    started = threading.Event()
    release = threading.Event()

    async def _blocks(_payload):
        started.set()
        assert release.wait(timeout=_WAIT_SECONDS), "the test never released the investigation"
        return {"status": "PROPOSED"}

    monkeypatch.setattr(agent, "_investigate_body", _blocks)
    sent: list = []
    monkeypatch.setattr(agent, "_send_task_success", lambda **kw: sent.append(kw))

    out = asyncio.run(agent.handler(_payload(token="tok"), None))

    assert out == {"status": "accepted"}
    assert started.wait(timeout=_WAIT_SECONDS), "the investigation never started"
    assert not sent, "the entrypoint waited for the investigation before returning"
    release.set()
    _join_investigation()

    assert [kw["task_token"] for kw in sent] == ["tok"]


def test_the_session_is_held_busy_for_exactly_the_investigation(monkeypatch, _no_flush):
    """The add/complete pairing is what keeps the container alive, so assert both ends of it.

    Without the registration AgentCore sees an idle session and reclaims the container mid-run;
    without the completion the session stays busy until the 8-hour lifetime expires. Neither failure
    is visible from the investigation's own result, which is why it is asserted here.
    """
    events: list[str] = []
    monkeypatch.setattr(agent.app, "add_async_task", lambda _name: events.append("busy") or 7)
    monkeypatch.setattr(
        agent.app, "complete_async_task", lambda task_id: events.append(f"idle:{task_id}")
    )

    async def _body(_payload):
        events.append("investigating")
        return {"status": "PROPOSED"}

    monkeypatch.setattr(agent, "_investigate_body", _body)
    monkeypatch.setattr(agent, "_send_task_success", lambda **_kw: None)

    agent._investigate_in_thread(_payload(token="tok"), "tok")

    assert events == ["busy", "investigating", "idle:7"]


def test_the_session_is_released_even_when_the_investigation_dies(monkeypatch, _no_flush):
    """A run that dies must still mark the session idle, or the container never gets reclaimed."""
    completed: list[int] = []
    monkeypatch.setattr(agent.app, "add_async_task", lambda _name: 3)
    monkeypatch.setattr(agent.app, "complete_async_task", completed.append)
    monkeypatch.setattr(agent, "_investigate_body", _async_raise(RuntimeError("throttled")))
    monkeypatch.setattr(agent, "_record_failure", lambda **_kw: None)
    monkeypatch.setattr(agent, "_send_task_failure", lambda **_kw: None)

    agent._investigate_in_thread(_payload(token="tok"), "tok")

    assert completed == [3]


def test_async_success_signals_the_token_with_the_result(monkeypatch, _no_flush):
    monkeypatch.setattr(agent, "_investigate_body", _async_return({"status": "PROPOSED"}))
    sent: list = []
    monkeypatch.setattr(agent, "_send_task_success", lambda **kw: sent.append(kw))

    agent._investigate_in_thread(_payload(token="tok"), "tok")

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

    agent._investigate_in_thread(_payload(token="tok"), "tok")

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


def _join_investigation(item_id: str = "i-1") -> None:
    """Wait for the background investigation thread to finish, so its callback is observable.

    Found by the name `handler` gives it rather than by a handle, because the entrypoint deliberately
    keeps no reference to the thread — it is fire-and-forget by design.

    :param item_id: the item whose investigation thread to join.
    :returns: None
    :raises AssertionError: when no such thread exists, or it does not finish in time.
    """
    matches = [t for t in threading.enumerate() if t.name == f"investigate-{item_id}"]
    assert matches, f"no investigation thread for {item_id}; the entrypoint did not start one"
    for thread in matches:
        thread.join(timeout=_WAIT_SECONDS)
        assert not thread.is_alive(), "the investigation thread did not finish"


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
