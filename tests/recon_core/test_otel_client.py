"""Client-side OTel helpers: enablement gate, header injection, baggage, spans, flush."""

import pytest
from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from backend.recon_core import otel_client


class _Request:
    """Stand-in for the botocore AWSPreparedRequest a before-send handler receives."""

    def __init__(self, headers: dict | None = None) -> None:
        """Store a mutable header mapping.

        :param headers: initial headers (default empty).
        """
        self.headers: dict = dict(headers or {})


@pytest.fixture()
def enabled(monkeypatch):
    """Switch tracing on for one test.

    :returns: None — sets AGENT_OBSERVABILITY_ENABLED for the test's duration.
    """
    monkeypatch.setenv("AGENT_OBSERVABILITY_ENABLED", "true")


@pytest.fixture()
def exporter(enabled):
    """Install a real SDK tracer provider with an in-memory exporter.

    The global tracer provider can only be set once per process, so an already-installed provider
    is reused and only the exporter is attached — the assertions only need the finished spans.

    :returns: the InMemorySpanExporter collecting finished spans.
    """
    exp = InMemorySpanExporter()
    provider = otel_trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        provider = TracerProvider()
        otel_trace.set_tracer_provider(provider)
    provider.add_span_processor(SimpleSpanProcessor(exp))
    exp.clear()
    return exp


def test_disabled_by_default_is_inert(monkeypatch):
    """With the flag unset nothing is emitted and no OTel import is required."""
    monkeypatch.delenv("AGENT_OBSERVABILITY_ENABLED", raising=False)
    assert otel_client.tracing_enabled() is False
    assert otel_client.otel_headers() == {}
    assert otel_client.set_recon_baggage(item_id="i-1") is None
    assert otel_client.force_flush() is False

    req = _Request({"Authorization": "AWS4-HMAC-SHA256 sig"})
    otel_client.inject_otel_headers(req)
    # Untouched: no trace headers added when tracing is off.
    assert req.headers == {"Authorization": "AWS4-HMAC-SHA256 sig"}

    with otel_client.traced("invoke_harness") as span:
        assert span is None


def test_enabled_flag_accepts_documented_truthy_values(monkeypatch):
    """Only 1/true/yes (any case) enable tracing; anything else leaves it off."""
    for value in ("1", "true", "TRUE", "Yes"):
        monkeypatch.setenv("AGENT_OBSERVABILITY_ENABLED", value)
        assert otel_client.tracing_enabled() is True
    for value in ("", "0", "false", "off"):
        monkeypatch.setenv("AGENT_OBSERVABILITY_ENABLED", value)
        assert otel_client.tracing_enabled() is False


def test_traced_records_span_with_attributes_and_duration(exporter):
    """A successful block yields a recording span carrying our attributes."""
    with otel_client.traced("invoke_harness", attributes={"recon.item_id": "i-1",
                                                         "recon.turn": 1,
                                                         "recon.skipped": None}) as span:
        assert span is not None

    spans = exporter.get_finished_spans()
    assert [s.name for s in spans] == ["invoke_harness"]
    attrs = spans[0].attributes
    assert attrs["recon.item_id"] == "i-1"
    assert attrs["recon.turn"] == 1
    assert "recon.skipped" not in attrs  # None values are skipped, not recorded as "None"
    assert attrs["execution.duration_ms"] >= 0
    assert spans[0].status.status_code is otel_trace.StatusCode.UNSET


def test_traced_records_exception_and_reraises(exporter):
    """A failing block marks the span ERROR, records the exception, and propagates it."""
    with pytest.raises(RuntimeError, match="stream broke"):
        with otel_client.traced("invoke_harness"):
            raise RuntimeError("stream broke")

    span = exporter.get_finished_spans()[0]
    assert span.status.status_code is otel_trace.StatusCode.ERROR
    assert "stream broke" in (span.status.description or "")
    assert [e.name for e in span.events] == ["exception"]
    # Duration is still recorded on the failure path.
    assert span.attributes["execution.duration_ms"] >= 0


def test_otel_headers_carry_traceparent_of_active_span(exporter):
    """Inside a span, injection produces a traceparent matching that span's ids."""
    with otel_client.traced("invoke_harness") as span:
        headers = otel_client.otel_headers()
        ctx = span.get_span_context()

    assert "traceparent" in headers
    assert f"{ctx.trace_id:032x}" in headers["traceparent"]
    assert f"{ctx.span_id:016x}" in headers["traceparent"]


def test_inject_otel_headers_preserves_signature_headers(exporter):
    """The before-send hook adds trace headers without touching the SigV4 Authorization header."""
    req = _Request({"Authorization": "AWS4-HMAC-SHA256 sig", "Content-Type": "application/json"})
    with otel_client.traced("invoke_harness"):
        otel_client.inject_otel_headers(req, operation_name="InvokeHarness")

    assert req.headers["Authorization"] == "AWS4-HMAC-SHA256 sig"
    assert req.headers["Content-Type"] == "application/json"
    assert "traceparent" in req.headers


@pytest.mark.parametrize(
    ("incoming", "expected"),
    [
        ("Root=1-abc-def", "Root=1-abc-def;Sampled=1"),
        ("Root=1-abc-def;Sampled=0", "Root=1-abc-def;Sampled=1"),
        ("Root=1-abc-def;Sampled=1", "Root=1-abc-def;Sampled=1"),
    ],
)
def test_inject_forces_sampled_on_xray_header(enabled, incoming, expected):
    """An unsampled/undecided X-Ray header is rewritten so downstream records the trace."""
    req = _Request({"X-Amzn-Trace-Id": incoming})
    otel_client.inject_otel_headers(req)
    assert req.headers["X-Amzn-Trace-Id"] == expected


def test_inject_does_not_invent_an_xray_header(enabled):
    """No X-Amzn-Trace-Id in, none fabricated out (only an existing one is corrected)."""
    req = _Request()
    otel_client.inject_otel_headers(req)
    assert "X-Amzn-Trace-Id" not in req.headers


def test_set_recon_baggage_propagates_allowlisted_keys(exporter):
    """Non-empty recon context lands in the injected baggage header; empties are omitted."""
    token = otel_client.set_recon_baggage(
        item_id="i-1", domain="otc", backend="harness", session_id=""
    )
    assert token is not None
    try:
        with otel_client.traced("invoke_harness"):
            headers = otel_client.otel_headers()
    finally:
        from opentelemetry import context as otel_context

        otel_context.detach(token)

    bag = headers["baggage"]
    assert "recon.item_id=i-1" in bag
    assert "recon.domain=otc" in bag
    assert "recon.backend=harness" in bag
    assert "session.id" not in bag  # empty values are not set


def test_set_recon_baggage_with_no_values_sets_nothing(enabled):
    """All-empty context attaches no baggage rather than empty keys."""
    assert otel_client.set_recon_baggage() is None


def test_register_trace_propagation_hooks_the_client(enabled):
    """The hook is registered on the client's event system under the before-send event."""
    registered = []

    class _Events:
        def register(self, event_name, handler):
            """Record a botocore event registration.

            :param event_name: the botocore event name.
            :param handler: the callable being registered.
            """
            registered.append((event_name, handler))

    class _Meta:
        events = _Events()

    class _Client:
        meta = _Meta()

    assert otel_client.register_trace_propagation(_Client()) is True
    assert registered == [("before-send.bedrock-agentcore.*", otel_client.inject_otel_headers)]


def test_register_trace_propagation_skipped_when_disabled(monkeypatch):
    """With tracing off the client is left unmodified (no hook, no OTel import)."""
    monkeypatch.delenv("AGENT_OBSERVABILITY_ENABLED", raising=False)

    class _Client:
        @property
        def meta(self):
            """Fail if touched — a disabled registration must not reach the event system."""
            raise AssertionError("client.meta must not be touched when tracing is disabled")

    assert otel_client.register_trace_propagation(_Client()) is False


def test_force_flush_returns_true_with_an_sdk_provider(exporter):
    """With a real SDK provider installed the flush happens; the no-op provider reports False."""
    assert otel_client.force_flush(timeout_millis=100) is True
