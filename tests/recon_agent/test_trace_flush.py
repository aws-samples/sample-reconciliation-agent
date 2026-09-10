"""The runtime entrypoint must export queued spans before AgentCore freezes the container.

Why this is worth a test rather than a one-line call nobody revisits: the failure it prevents is
almost invisible. `opentelemetry-instrument` installs a `BatchSpanProcessor` that exports on a ~5s
timer, and AgentCore reclaims the container the moment the entrypoint returns — so a SHORT
investigation returns with nearly every span still queued and loses them, while a LONG one looks
perfectly healthy because the batch timer fired several times mid-run.

What that looks like live: runtime sessions with thousands of spans sitting alongside sessions with
exactly **1**. Online evaluation groups spans by session and cannot score a single span, so
those cases read "No evaluation recorded for this case" indefinitely — with the evaluation config, its
execution role, its data source and its evaluators all correct throughout. Nothing anywhere reports the
difference, which is precisely why deleting the flush would go unnoticed.

The tests below therefore pin three things: that the flush is actually requested, that a missing
`force_flush` (no instrumentation, as in local runs and this suite) is treated as normal rather than
an error, and that a failing collector cannot take the invocation down with it.
"""

from __future__ import annotations

import logging

import agent


class _RecordingProvider:
    """A tracer provider that records the flush it was asked for."""

    def __init__(self, blow_up: bool = False) -> None:
        """Set up the recorder.

        :param blow_up: raise from ``force_flush`` to simulate an unreachable collector.
        """
        self.calls: list[int | None] = []
        self._blow_up = blow_up

    def force_flush(self, timeout_millis: int | None = None) -> None:
        """Record the call, or raise when asked to simulate a broken exporter.

        :param timeout_millis: the caller's timeout budget.
        :raises RuntimeError: when constructed with ``blow_up``.
        """
        self.calls.append(timeout_millis)
        if self._blow_up:
            raise RuntimeError("collector unreachable")


def _use_provider(monkeypatch, provider: object) -> None:
    """Make ``opentelemetry.trace.get_tracer_provider`` return ``provider``.

    :param monkeypatch: pytest's monkeypatch fixture.
    :param provider: the object to hand back.
    """
    from opentelemetry import trace

    monkeypatch.setattr(trace, "get_tracer_provider", lambda: provider)


def test_flush_requests_an_export_with_a_bounded_timeout(monkeypatch) -> None:
    """Spans must be pushed out, and the wait must be bounded.

    Unbounded would let a wedged collector hold a finished case hostage: the proposal is worth more
    than its trace, so the flush gets a budget and then gives up.

    :param monkeypatch: pytest's monkeypatch fixture.
    """
    provider = _RecordingProvider()
    _use_provider(monkeypatch, provider)

    agent.flush_traces()

    assert provider.calls == [agent._TRACE_FLUSH_TIMEOUT_MS]
    assert 0 < agent._TRACE_FLUSH_TIMEOUT_MS <= 30_000


def test_a_provider_without_force_flush_is_not_an_error(monkeypatch, caplog) -> None:
    """No instrumentation means a NoOp provider, which has no ``force_flush``.

    That is the normal shape for a local run and for this suite, so it must pass silently. Logging a
    warning here would cry wolf on every test run and train people to ignore the one that matters.

    :param monkeypatch: pytest's monkeypatch fixture.
    :param caplog: pytest's log-capture fixture.
    """
    _use_provider(monkeypatch, object())

    with caplog.at_level(logging.WARNING):
        agent.flush_traces()

    assert caplog.records == []


def test_a_failing_collector_never_breaks_the_invocation(monkeypatch, caplog) -> None:
    """A tracing failure must not propagate.

    The entrypoint calls this AFTER the proposal is persisted. Raising here would turn a lost trace
    into a lost case — and the retry would re-run an investigation whose result was already stored.

    :param monkeypatch: pytest's monkeypatch fixture.
    :param caplog: pytest's log-capture fixture.
    """
    provider = _RecordingProvider(blow_up=True)
    _use_provider(monkeypatch, provider)

    with caplog.at_level(logging.WARNING):
        agent.flush_traces()  # must not raise

    assert provider.calls, "the flush was never attempted"
    # Silent would be worse than noisy: an incomplete trace has to leave a trail somewhere.
    assert any("flush failed" in r.message for r in caplog.records)


def test_the_entrypoint_flushes_on_its_way_out() -> None:
    """The call has to be on the return path, not merely defined.

    Asserted against the source because the entrypoint is unmockable wiring — it reads S3, builds a
    Strands agent and persists a case. What matters is the ordering: the flush must be the last thing
    before the response, since the container is reclaimed as soon as it is returned.
    """
    from pathlib import Path

    source = Path(agent.__file__).read_text(encoding="utf-8")
    handler = source.split("@app.entrypoint", 1)[1]
    flush_at = handler.find("flush_traces()")
    response_at = handler.find('"item_id": item.item_id')

    assert flush_at != -1, (
        "the entrypoint does not flush spans; short sessions will lose their trace"
    )
    assert flush_at < response_at, "the flush must happen BEFORE the response is returned"
