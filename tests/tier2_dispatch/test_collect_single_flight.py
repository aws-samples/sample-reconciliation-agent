"""The single-flight guard: MaxConcurrency is per Map Run, so overlap must be prevented.

Without this, a 5-minute schedule against runs that last longer stacks executions, each with its own
full MaxConcurrency allowance, and the Bedrock token budget is exceeded by the overlap factor. The cap
would still be configured and would still mean nothing.
"""

import pytest
from moto import mock_aws

from backend.tier2_dispatch import collect

_ARN = "arn:aws:states:us-east-1:1:stateMachine:recon-dev-tier2"


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("RUNS_BUCKET", "runs-bucket")
    monkeypatch.setenv("CASES_TABLE", "recon-cases")
    monkeypatch.setenv("AGENT_BACKEND_PARAM", "")
    monkeypatch.setenv("STATE_MACHINE_ARN", _ARN)


def _sfn(running_names: list[str]):
    """Fake stepfunctions client whose paginator yields the given RUNNING execution names."""

    class _Paginator:
        def paginate(self, **_kw):
            yield {"executions": [{"name": n} for n in running_names]}

    class _C:
        def get_paginator(self, _name):
            return _Paginator()

    return _C()


def test_collects_when_only_this_execution_is_running(_env, monkeypatch):
    monkeypatch.setattr(collect.boto3, "client", lambda _n, **_kw: _sfn(["run-1"]))

    assert collect._another_run_in_flight(execution_name="run-1") is False


def test_refuses_when_another_execution_is_running(_env, monkeypatch):
    monkeypatch.setattr(collect.boto3, "client", lambda _n, **_kw: _sfn(["run-1", "run-0"]))

    assert collect._another_run_in_flight(execution_name="run-1") is True


def test_a_previous_runs_map_child_counts_as_in_flight(_env, monkeypatch):
    """Distributed Map children are executions of the same state machine, and their being RUNNING is
    exactly the evidence that the earlier run has not drained."""
    monkeypatch.setattr(
        collect.boto3, "client", lambda _n, **_kw: _sfn(["run-1", "run-0/Investigate:abc123"])
    )

    assert collect._another_run_in_flight(execution_name="run-1") is True


def test_fails_CLOSED_when_the_check_errors(_env, monkeypatch):
    """Skipping a cycle costs 5 minutes; guessing the other way multiplies the token budget."""

    class _Boom:
        def get_paginator(self, _n):
            raise RuntimeError("access denied")

    monkeypatch.setattr(collect.boto3, "client", lambda _n, **_kw: _Boom())

    assert collect._another_run_in_flight(execution_name="run-1") is True


def test_fails_CLOSED_when_the_arn_is_unwired(_env, monkeypatch):
    """An unset ARN means the guard cannot work; proceeding would remove the global bound."""
    monkeypatch.delenv("STATE_MACHINE_ARN", raising=False)

    assert collect._another_run_in_flight(execution_name="run-1") is True


@mock_aws
def test_handle_short_circuits_without_touching_dynamo_or_s3(_env, monkeypatch):
    """No table, no bucket: if the guard did not short-circuit, this would raise."""
    monkeypatch.setattr(collect.boto3, "client", lambda _n, **_kw: _sfn(["other-run"]))

    out = collect.handle({"execution_name": "run-1"}, None)

    assert out["count"] == 0
    assert out["skipped"] == "run_in_flight"
