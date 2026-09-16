"""Token usage captured by the harness worker: summed across turns, labelled with the real model.

The trap these tests exist for: ``run_investigation`` calls InvokeHarness ONCE PER ROUND TRIP (one
turn to reach ``submit_proposal``, another to close the session with the decision), so assigning the
latest turn's ``usage`` instead of summing every turn's undercounts every real case while a
single-turn case still looks correct. Every assertion below therefore checks SUMMED values, not the
mere presence of a number.

Uses the same injected invoke transport as ``test_worker_loop.py`` plus moto for the case store.
"""

import inspect
from decimal import Decimal

import time

import boto3
from moto import mock_aws

from backend.harness_agent import worker
from backend.harness_agent.config_store import apply_overrides, resolved_model_id
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import EvidenceStep, ReconItem

# The deploy-time default a hard-coded model id would most plausibly be taken from — asserted
# ABSENT from the stored usage in the resolved-config test below.
BLUEPRINT_DEFAULT_MODEL = "us.anthropic.claude-sonnet-5"

CATALOG = [
    {
        "name": "document-cross-reference",
        "confidence_threshold": 0.7,
        "evidence_steps": [
            EvidenceStep(id="ledger_hit", description="the ledger entry"),
            EvidenceStep(id="notice_hit", description="the notice"),
        ],
    },
    {"name": "unknown", "confidence_threshold": 0.0},
]
ITEM = ReconItem(
    item_id="idp-1",
    domain="loan-servicing",
    sides=[{"name": "ledger", "attributes": {"reference": "DDTL-A-0001"}}],
    attributes={"idp_class": "LoanDrawCancellationNotice"},
)


def _tables():
    """Create the cases + audit tables in moto and seed the IN_PROGRESS case row.

    :returns: the moto DynamoDB resource, for row assertions.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName="recon-audit",
        KeySchema=[
            {"AttributeName": "item_id", "KeyType": "HASH"},
            {"AttributeName": "ts", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "ts", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.Table("recon-cases").put_item(Item={"item_id": "idp-1", "status": "IN_PROGRESS"})
    return ddb


def _metadata(**usage):
    """One ``metadata`` stream event carrying a raw (camelCase) usage block.

    :param usage: the raw Bedrock usage keys for this turn.
    :returns: the event dict.
    """
    return {"metadata": {"usage": dict(usage)}}


def _submit_turn(*, satisfied=("ledger_hit",), usage=None):
    """A first turn: one search_ledger call, then a submit_proposal that stops the stream.

    :param satisfied: which prescribed evidence steps the model reports as obtained.
    :param usage: raw usage block for this turn, or None to emit no ``metadata`` event at all.
    :returns: the list of stream events.
    """
    reports = ",".join(
        '{"step_id":"%s","satisfied":%s}' % (sid, "true" if sid in satisfied else "false")
        for sid in ("ledger_hit", "notice_hit")
    )
    body = (
        '{"class_name":"document-cross-reference","classification_reasoning":"x",'
        '"resolution":"Mark cancelled","status":"Cancelled","reason":"pushed",'
        '"evidence":["reference: DDTL-A-0001"],'
        f'"evidence_steps":[{reports}]}}'
    )
    events = [
        {
            "contentBlockStart": {
                "contentBlockIndex": 0,
                "start": {"toolUse": {"toolUseId": "t1", "name": "general-ledger___search_ledger"}},
            }
        },
        {
            "contentBlockDelta": {
                "contentBlockIndex": 0,
                "delta": {"toolUse": {"input": '{"reference":"DDTL-A-0001"}'}},
            }
        },
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {
            "toolResult": {
                "toolUseId": "t1",
                "name": "general-ledger___search_ledger",
                "content": [{"json": {"rows": [{"reference": "DDTL-A-0001"}]}}],
                "status": "success",
            }
        },
        {
            "contentBlockStart": {
                "contentBlockIndex": 1,
                "start": {"toolUse": {"toolUseId": "t2", "name": "submit_proposal"}},
            }
        },
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": body}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]
    return events + ([_metadata(**usage)] if usage else [])


def _closing_turn(*, usage=None):
    """The second turn: the informational summary the worker re-invokes for.

    :param usage: raw usage block for this turn, or None to emit no ``metadata`` event.
    :returns: the list of stream events.
    """
    events = [{"messageStop": {"stopReason": "end_turn"}}]
    return events + ([_metadata(**usage)] if usage else [])


def _run(turns, *, model_id=BLUEPRINT_DEFAULT_MODEL, threshold=0.6):
    """Drive ``run_investigation`` over a list of per-turn event lists.

    :param turns: one event list per InvokeHarness round trip, in order.
    :param model_id: the resolved model id handed to the worker.
    :param threshold: the auto-resolve threshold (0.6 with one satisfied step of two ⇒ escalate).
    :returns: the run outcome string.
    """
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    stream = iter(turns)
    return worker.run_investigation(
        item=ITEM,
        invoke=lambda _m: next(stream),
        cases=cases,
        catalog=CATALOG,
        threshold=threshold,
        write_transport=lambda _t, _a: {"content": []},
        model_id=model_id,
        deadline=time.monotonic() + 900.0,
    )


def _stored_usage():
    """Read the persisted ``token_usage`` attribute off the case row.

    :returns: the stored dict, or None when the run measured nothing.
    """
    row = (
        boto3.resource("dynamodb", region_name="us-east-1")
        .Table("recon-cases")
        .get_item(Key={"item_id": "idp-1"})["Item"]
    )
    return row.get("token_usage")


@mock_aws
def test_usage_totals_add_across_both_turns() -> None:
    """Both round trips' counts are summed — the regression guard for "keep the last turn".

    Asserted as exact totals: a test that only checked for a non-empty dict would pass against the
    bug this whole task exists to prevent, since the final turn always reports SOMETHING.

    :returns: None.
    """
    _tables()
    outcome = _run(
        [
            _submit_turn(usage={"inputTokens": 1200, "outputTokens": 300}),
            _closing_turn(usage={"inputTokens": 1800, "outputTokens": 45}),
        ]
    )
    assert outcome == "escalated"

    stored = _stored_usage()
    assert stored["input_tokens"] == Decimal("3000")  # 1200 + 1800, not 1800
    assert stored["output_tokens"] == Decimal("345")  # 300 + 45, not 45
    assert stored["backend"] == "harness"
    assert stored["model_id"] == BLUEPRINT_DEFAULT_MODEL


@mock_aws
def test_a_stream_with_no_metadata_event_persists_none() -> None:
    """No usage reported anywhere ⇒ ``None``, never a dict of zeros.

    Zeros would render as a run that cost nothing, which is a claim about the run rather than about
    the measurement.

    :returns: None.
    """
    _tables()
    outcome = _run([_submit_turn(), _closing_turn()])
    assert outcome == "escalated"
    assert _stored_usage() is None


@mock_aws
def test_cache_keys_absent_on_the_wire_stay_absent() -> None:
    """A model call that reported no cache figures must not gain zeroed cache counts.

    :returns: None.
    """
    _tables()
    _run(
        [
            _submit_turn(usage={"inputTokens": 10, "outputTokens": 2}),
            _closing_turn(usage={"inputTokens": 4, "outputTokens": 1}),
        ]
    )
    stored = _stored_usage()
    assert stored["input_tokens"] == Decimal("14")
    assert "cache_read_tokens" not in stored
    assert "cache_write_tokens" not in stored


@mock_aws
def test_cache_reads_reported_on_one_turn_are_stored_for_that_turn() -> None:
    """The mixed case end to end: one turn reports cache reads, the other does not.

    :returns: None.
    """
    _tables()
    _run(
        [
            _submit_turn(
                usage={"inputTokens": 10, "outputTokens": 2, "cacheReadInputTokens": 4096}
            ),
            _closing_turn(usage={"inputTokens": 4, "outputTokens": 1}),
        ]
    )
    stored = _stored_usage()
    assert stored["cache_read_tokens"] == Decimal("4096")
    assert "cache_write_tokens" not in stored


@mock_aws
def test_the_model_id_is_the_one_the_resolved_config_selected() -> None:
    """The stored label follows the DEPLOYED config version, not the deploy-time default.

    An operator can switch models at runtime (SSM selection, or a deployed config version that
    overrides it). The usage is priced against this id later, so a hard-coded default would misprice
    every run made after such a switch — and nothing downstream could detect it. The id is therefore
    read back off the very kwargs the worker sends, which is what ``resolved_model_id`` does.

    :returns: None.
    """
    _tables()
    invoke_kwargs = apply_overrides(
        config={"model_id": "us.anthropic.claude-opus-4-5-20260101-v1:0"},
        base_model=BLUEPRINT_DEFAULT_MODEL,
        base_system_prompt="policy",
    )
    resolved = resolved_model_id(invoke_kwargs=invoke_kwargs)

    _run(
        [
            _submit_turn(usage={"inputTokens": 10, "outputTokens": 2}),
            _closing_turn(usage={"inputTokens": 1, "outputTokens": 1}),
        ],
        model_id=resolved,
    )

    stored = _stored_usage()
    assert stored["model_id"] == "us.anthropic.claude-opus-4-5-20260101-v1:0"
    # The assertion that fails if someone reintroduces a default: the base model is what a
    # hard-coded id would have stored.
    assert stored["model_id"] != BLUEPRINT_DEFAULT_MODEL


def test_run_investigation_has_no_default_model_id() -> None:
    """A default is the mechanism by which a mislabelled run would go unnoticed, so there is none.

    Asserted on the signature because the caller (``worker.handle``) is live wiring that no unit test
    executes; without this, deleting the ``model_id=`` argument there would only surface as
    mispriced production data.

    :returns: None.
    """
    param = inspect.signature(worker.run_investigation).parameters["model_id"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    assert param.default is inspect.Parameter.empty


@mock_aws
def test_a_degraded_run_still_records_what_it_burned() -> None:
    """A run that stops early (timeout) spent its tokens; the cost figure must not omit it.

    :returns: None.
    """
    _tables()
    outcome = _run(
        [
            [
                {"messageStop": {"stopReason": "timeout_exceeded"}},
                _metadata(inputTokens=900, outputTokens=12),
            ],
        ]
    )
    assert outcome == "escalated"
    stored = _stored_usage()
    assert stored["input_tokens"] == Decimal("900")
    assert stored["output_tokens"] == Decimal("12")
