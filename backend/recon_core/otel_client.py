"""Client-side OpenTelemetry helpers for AgentCore invocations (spans, baggage, propagation).

AgentCore traces what happens INSIDE a harness/runtime, but the caller side is invisible and
**boto3 does not propagate trace context** — no ``traceparent``, no ``baggage``. Without the
helpers here, the spans an agent emits belong to a different trace than the Lambda invocation
that caused them, and none of the business context the caller knows (which recon item? which
domain? which backend?) is attached to them.

This module supplies the three pieces that fix that, following
https://github.com/aws-samples/sample-ac-harness-observability:

  * :func:`inject_otel_headers` / :func:`register_trace_propagation` — a botocore ``before-send``
    hook that writes the W3C headers onto the already-signed request, so the agent's spans become
    children of ours;
  * :func:`set_recon_baggage` — puts caller-known context into W3C baggage, which AgentCore turns
    into span attributes for the keys listed in ``OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS``;
  * :func:`traced` — a custom span around each invocation, flushed before Lambda freezes.

**Enablement is explicit, not inferred.** Every function is a no-op unless
``AGENT_OBSERVABILITY_ENABLED`` is truthy. That variable is set by the same Terraform that
attaches the ADOT Lambda layer (which is what PROVIDES the ``opentelemetry`` packages — they are
deliberately not vendored into the shared Lambda zip). So:

  * flag off  → no OTel import is even attempted, and callers on Lambdas without the layer
    (intake, IDP hook, API) keep working untouched;
  * flag on but the packages are missing → :exc:`RuntimeError`. That is a real deployment
    mismatch (env set, layer absent) and must not be papered over.
"""

import logging
import os
import time
from contextlib import contextmanager
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)

_TRUTHY = ("1", "true", "yes")

# Baggage keys this app sets. Every key here MUST also appear in the
# OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS allow-list of EVERY participant — the worker Lambda, the
# harness definition, and the Runtime container (see infra/modules/tier1,
# infra/modules/recon-agent-harness, and infra/modules/recon-agent). The allow-list is per-process:
# a participant without it will carry the keys on the wire but never promote them to span
# attributes — the whole point of setting them.
BAGGAGE_ITEM_ID = "recon.item_id"
BAGGAGE_DOMAIN = "recon.domain"
BAGGAGE_BACKEND = "recon.backend"
BAGGAGE_SESSION_ID = "session.id"


def tracing_enabled() -> bool:
    """Report whether client-side tracing is switched on for this Lambda.

    :returns: True when ``AGENT_OBSERVABILITY_ENABLED`` is one of "1"/"true"/"yes"
        (case-insensitive). Read on every call, not cached, so tests can toggle it.
    """
    return os.environ.get("AGENT_OBSERVABILITY_ENABLED", "").strip().lower() in _TRUTHY


def _otel() -> tuple[Any, Any, Any, Any]:
    """Import the OpenTelemetry pieces this module needs, failing loudly when they are absent.

    Imported lazily (not at module scope) because the packages come from the ADOT Lambda layer,
    which is only attached to the agent-worker Lambda — other Lambdas share the same zip and
    must not break on an import they never need.

    :returns: the tuple ``(trace, propagate, baggage, otel_context)`` modules.
    :raises RuntimeError: when tracing is enabled but the packages are not importable, i.e. the
        env var was set without the layer being attached.
    """
    try:
        from opentelemetry import baggage as otel_baggage
        from opentelemetry import context as otel_context
        from opentelemetry import propagate, trace
    except ImportError as exc:  # pragma: no cover - deployment mismatch, not a test path
        raise RuntimeError(
            "AGENT_OBSERVABILITY_ENABLED is set but the opentelemetry packages are missing. "
            "The ADOT Lambda layer (AWSOpenTelemetryDistroPython) provides them — attach it "
            "(Terraform: otel_layer_arn) or unset AGENT_OBSERVABILITY_ENABLED."
        ) from exc
    return trace, propagate, otel_baggage, otel_context


def otel_headers() -> dict[str, str]:
    """Serialize the current trace context (and baggage) into a fresh header dict.

    Uses the configured propagators, so which headers appear depends on ``OTEL_PROPAGATORS``
    (we configure ``tracecontext,baggage,xray-lambda,xray``).

    :returns: header name → value; empty when tracing is disabled or no context is active.
    """
    if not tracing_enabled():
        return {}
    _, propagate, _, _ = _otel()
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier


def _force_sampled(headers: dict[str, str]) -> None:
    """Rewrite an X-Ray trace header in place so the downstream service records the trace.

    A propagated ``X-Amzn-Trace-Id`` may carry ``Sampled=0`` (or no sampling decision at all);
    either way AgentCore would drop the segment and the trace would end at our span.

    :param headers: mutable header mapping to fix up.
    :returns: None; ``headers`` is modified in place.
    """
    xray = headers.get("X-Amzn-Trace-Id", "")
    if not xray:
        return
    if "Sampled=" not in xray:
        headers["X-Amzn-Trace-Id"] = f"{xray};Sampled=1"
    elif "Sampled=0" in xray:
        headers["X-Amzn-Trace-Id"] = xray.replace("Sampled=0", "Sampled=1")


def inject_otel_headers(request, **_kwargs) -> None:
    """botocore ``before-send`` hook: add W3C trace headers to an already-signed request.

    Registered via :func:`register_trace_propagation`. ``before-send`` fires AFTER SigV4 signing,
    which is exactly what makes this safe — the added headers are simply not covered by the
    signature, so they cannot invalidate it. (Injecting before signing would either break the
    signature or require the headers to be part of the canonical request.)

    :param request: the botocore ``AWSPreparedRequest`` about to go on the wire; its ``headers``
        mapping is mutated.
    :param _kwargs: the rest of the botocore event payload (``operation_name``, …), unused.
    :returns: None — a ``before-send`` handler returning None lets the request proceed normally
        (returning a response object would short-circuit the call).
    """
    headers = otel_headers()
    for key, value in headers.items():
        request.headers[key] = value
    _force_sampled(request.headers)
    logger.debug("injected OTel headers: %s", sorted(headers))


def register_trace_propagation(client) -> bool:
    """Register :func:`inject_otel_headers` on a boto3 ``bedrock-agentcore`` client.

    :param client: a boto3 client whose requests should carry trace context.
    :returns: True when the hook was registered, False when tracing is disabled.
    """
    if not tracing_enabled():
        return False
    # Event name is per-service; the trailing ".*" covers every operation on the client.
    client.meta.events.register("before-send.bedrock-agentcore.*", inject_otel_headers)
    return True


def set_recon_baggage(
    *, item_id: str = "", domain: str = "", backend: str = "", session_id: str = ""
) -> Optional[object]:
    """Put caller-known recon context into W3C baggage for the rest of this invocation.

    Baggage rides the wire with the trace context, and AgentCore promotes allow-listed keys to
    span attributes on the AGENT's spans — so an agent span becomes searchable by the business
    key (``recon.item_id``) that a human actually has in hand.

    Only non-empty values are set. The resulting context is attached to the current execution
    context and intentionally NOT detached: it should apply for the whole Lambda invocation, and
    the next invocation overwrites the same keys.

    :param item_id: recon item id being investigated.
    :param domain: recon domain of the item (e.g. ``"otc"``).
    :param backend: which agent backend serves it (``"harness"`` / ``"runtime"``).
    :param session_id: AgentCore runtime session id for this investigation.
    :returns: the context token from ``attach`` (for callers that want to detach), or None when
        tracing is disabled or every value was empty.
    """
    if not tracing_enabled():
        return None
    _, _, otel_baggage, otel_context = _otel()
    values = {
        BAGGAGE_ITEM_ID: item_id,
        BAGGAGE_DOMAIN: domain,
        BAGGAGE_BACKEND: backend,
        BAGGAGE_SESSION_ID: session_id,
    }
    ctx = None
    for key, value in values.items():
        if value:
            ctx = otel_baggage.set_baggage(key, str(value), context=ctx)
    if ctx is None:
        return None
    return otel_context.attach(ctx)


def force_flush(timeout_millis: int = 5000) -> bool:
    """Flush pending spans to the exporter.

    Required in Lambda: the execution environment is frozen the instant the handler returns, so a
    ``BatchSpanProcessor``'s queued spans would never be exported.

    :param timeout_millis: max time to wait for the export, in milliseconds.
    :returns: True when a flush was performed; False when tracing is disabled or the active
        provider is the API-level no-op/proxy provider (which has no ``force_flush``) — that is
        the normal state in unit tests with no SDK provider configured.
    """
    if not tracing_enabled():
        return False
    trace, _, _, _ = _otel()
    flush = getattr(trace.get_tracer_provider(), "force_flush", None)
    if not callable(flush):
        return False
    flush(timeout_millis)
    return True


@contextmanager
def traced(span_name: str, *, attributes: Optional[dict] = None) -> Iterator[Any]:
    """Run a block inside a client-side span, recording exceptions, duration, and flushing after.

    Yields None (rather than raising) when tracing is disabled, so call sites read the same in
    both modes: ``with traced("invoke_harness"): ...``.

    :param span_name: span name, e.g. ``"invoke_harness"``.
    :param attributes: span attributes to set on entry; values must be OTel-serializable
        (str/bool/int/float or a sequence of one type). None values are skipped.
    :yields: the active ``Span``, or None when tracing is disabled.
    :raises Exception: re-raises whatever the block raised, after recording it on the span.
    """
    if not tracing_enabled():
        yield None
        return

    trace, _, _, _ = _otel()
    from opentelemetry.trace import StatusCode

    # Tracer is fetched per call, not at import time, so the ADOT provider installed by the
    # /opt/otel-instrument wrapper is already in place (a tracer grabbed at import time would be
    # bound to the no-op provider forever).
    tracer = trace.get_tracer(__name__)
    started = time.perf_counter()
    try:
        # record_exception / set_status_on_exception are off because we do both explicitly below;
        # leaving them on records the SAME exception twice as two "exception" span events.
        with tracer.start_as_current_span(
            span_name, record_exception=False, set_status_on_exception=False
        ) as span:
            for key, value in (attributes or {}).items():
                if value is not None:
                    span.set_attribute(key, value)
            try:
                yield span
            except Exception as exc:
                span.record_exception(exc)
                span.set_status(StatusCode.ERROR, description=str(exc))
                raise
            finally:
                span.set_attribute(
                    "execution.duration_ms", (time.perf_counter() - started) * 1000
                )
    finally:
        # In a `finally`, unlike the reference sample where the flush sits after the `with` block
        # on a path the success `return` skips — an unreachable flush is the same as none.
        force_flush()
