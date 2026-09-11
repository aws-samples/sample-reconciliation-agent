"""Tier-2 dispatch: start an investigation and return, instead of blocking on it.

Two Lambdas, both driven by the Tier-2 state machine (``infra/modules/tier2-dispatch``):

* ``handler`` — the dispatcher. Invokes the agent runtime with a Step Functions task token on the
  payload and returns in about a second. The agent signals completion on that token, so nothing
  holds a connection open for the minutes an investigation takes.
* ``collect`` — reads PENDING cases and writes the list to S3, because a Distributed Map's
  ``ItemReader`` can only read from S3 and 5000 item ids do not fit in a 256 KB state payload.

Contrast with ``backend/tier1/agent_worker.py``, which is still the BLOCKING dispatcher and is still
used: the harness backend runs in-process there, and the frontend's single-case Retry invokes it
directly. That is why the worker keeps its concurrency cap while this path is bounded by the map's
``MaxConcurrency`` instead.
"""
