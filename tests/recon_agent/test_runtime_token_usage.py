"""Token usage captured by the runtime (container) backend: summed across k+1 Strands calls.

The trap these tests exist for. One invocation of this backend makes **k+1** model calls, not one:
``llm.classify_with_consistency`` draws ``samples`` independent single-turn samples — a FRESH
``strands.Agent`` each, so each carries its own ``metrics.accumulated_usage`` — and the investigation
loop is a further run with its own. Reading only the investigation's report (the single largest, and
the obvious one to reach for) stores roughly a quarter of real spend at the k=3 the code defaults to,
and the number looks entirely plausible on the case screen. Every assertion below therefore checks
SUMMED totals with the arithmetic spelled out, never the mere presence of a number.

The whole k+1 sequence is replayed the way ``agent.handler`` assembles it — real
``classify_with_consistency``, real ``make_strands_investigator``, real ``persist_and_execute`` over
moto — with only the two Strands seams faked. That is deliberate: the bug this guards against is a
usage report going unrecorded at one of those two call sites, which a test that hand-built the usage
list could not see.
"""

import inspect
import json
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from agent import (
    observed_tools_from,
    persist_and_execute,
    resolve_model_id,
    score_by_evidence,
)
from classifier import pick_class
from llm import ClassificationVote, classify_with_consistency, strands_json
from proposal import build_proposal
from strands_investigator import make_strands_investigator

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import EvidenceStep, ReconItem, ReconSide
from backend.recon_core.status import CaseStatus

# The deploy-time fallback in ``agent.resolve_model_id``, i.e. the id a hard-coded default would most
# plausibly be taken from — asserted ABSENT from the stored usage in the resolved-model test below.
BLUEPRINT_DEFAULT_MODEL = "us.anthropic.claude-sonnet-5"
# What an operator selects in the Config tab instead. Must be in ``model_select.ALLOWED_MODEL_IDS``,
# because the resolver enforces the allowlist on READ and would otherwise fall back to the default —
# which is the very thing this file's model-id test claims to detect.
OPERATOR_SELECTED_MODEL = "us.anthropic.claude-opus-5"

ITEM = ReconItem(
    item_id="i-1",
    domain="loan-servicing",
    sides=[ReconSide(name="ledger", attributes={"reference": "DDTL-A-0001"})],
)
CATALOG = [
    {"name": "record-match-review", "description": "ledger/notice cross-reference"},
    {"name": "unknown", "description": "fallback"},
]
# One required evidence step, which the fake investigation reports as satisfied — so the computed
# confidence is 1.0 and the auto-resolve test below is gated only by its threshold.
SKILLS = [
    {
        "name": "record-match-review",
        "body": "Look the reference up in the ledger.",
        "evidence_steps": [EvidenceStep(id="ledger_hit", description="the ledger entry")],
    }
]

# Per-sample classification counts. Sample n (1-based) reports n times these, so the samples are
# DISTINGUISHABLE: with identical counts, "sum the k samples" and "keep the last sample and multiply"
# produce the same total on some k, and a last-sample-wins bug could hide inside the arithmetic.
CLASSIFY_INPUT_STEP = 100
CLASSIFY_OUTPUT_STEP = 10
# The investigation loop's own total, an order of magnitude larger than any one sample — which is what
# makes reading only this one look believable.
INVESTIGATION_INPUT = 5000
INVESTIGATION_OUTPUT = 400


class _SampleCaller:
    """The classification seam: one canned reply per sample, each with its own usage report.

    Returns the ``(text, stop_reason, usage)`` triple ``llm.strands_json`` expects.

    :param cache_read_on: 1-based sample numbers that report ``cacheReadInputTokens``; every other
        sample omits the key entirely, exactly as Bedrock does when there was no cache hit.
    :param report_usage: False makes every sample report NO counts at all (an empty usage dict),
        which is what a provider that reports nothing looks like.
    """

    def __init__(self, *, cache_read_on: tuple[int, ...] = (), report_usage: bool = True):
        self.calls = 0
        self._cache_read_on = cache_read_on
        self._report_usage = report_usage

    def __call__(self, *, model_id, system, prompt, max_tokens, temperature):
        """Record the sample and return its canned reply plus usage.

        :returns: ``(reply text, stop reason, raw camelCase usage dict)``.
        """
        self.calls += 1
        reply = json.dumps({"name": "record-match-review", "reasoning": f"sample {self.calls}"})
        if not self._report_usage:
            return reply, "end_turn", {}
        usage = {
            "inputTokens": CLASSIFY_INPUT_STEP * self.calls,
            "outputTokens": CLASSIFY_OUTPUT_STEP * self.calls,
            # Present because Strands always sets it, and asserted ABSENT from the stored row: a total
            # that could disagree with its own parts is worse than no total.
            "totalTokens": (CLASSIFY_INPUT_STEP + CLASSIFY_OUTPUT_STEP) * self.calls,
        }
        if self.calls in self._cache_read_on:
            usage["cacheReadInputTokens"] = 4096
        return reply, "end_turn", usage


class _FakeMetrics:
    """Stand-in for Strands' ``EventLoopMetrics`` — only ``accumulated_usage`` is read."""

    def __init__(self, usage: dict):
        self.accumulated_usage = usage


class _FakeAgentResult:
    """Stand-in for a Strands ``AgentResult``: a final assistant message plus run metrics."""

    def __init__(self, *, text: str, usage: dict | None):
        self.message = {"role": "assistant", "content": [{"text": text}]}
        self.stop_reason = "end_turn"
        # ``None`` models a result object with NO metrics at all (which is what the plain-string fakes
        # elsewhere in this suite behave like), as distinct from metrics reporting an empty usage.
        if usage is not None:
            self.metrics = _FakeMetrics(usage)


def _tool_caller(name: str, args: dict) -> dict:
    """Gateway transport stand-in: one clean ledger reference, nothing else.

    :param name: the tool being called.
    :param args: the tool arguments; ignored.
    :returns: the canned tool result.
    """
    if name == "search_ledger":
        return {"rows": [{"reference": "DDTL-A-0001"}]}
    return {}


def _investigation_factory(*, usage: dict | None):
    """An ``agent_factory`` whose agent calls ``search_ledger`` then emits the final proposal JSON.

    Calls the tool for real (through the registered ``@tool`` callables) so the trace carries a
    ``tool_call`` with output — which is what ``observed_tools_from`` needs for the reported evidence
    step to keep its credit, and hence what lets the auto-resolve test clear a threshold.

    :param usage: the loop's ``accumulated_usage``, or None for a result carrying no metrics.
    :returns: ``callable(model_id, system_prompt, tools) -> agent``.
    """

    def factory(model_id, system_prompt, tools):
        by_name = {t.tool_name if hasattr(t, "tool_name") else t.__name__: t for t in tools}

        class _FakeAgent:
            def __call__(self, prompt):
                by_name["search_ledger"](reference="DDTL-A-0001")
                final = {
                    "resolution": "Mark the draw cancelled.",
                    "evidence": ["reference: DDTL-A-0001"],
                    "status": "Cancelled",
                    "reason": "pushed",
                    "evidence_steps": [
                        {"step_id": "ledger_hit", "satisfied": True, "note": "found"}
                    ],
                }
                return _FakeAgentResult(text=json.dumps(final), usage=usage)

        return _FakeAgent()

    return factory


INVESTIGATION_USAGE = {
    "inputTokens": INVESTIGATION_INPUT,
    "outputTokens": INVESTIGATION_OUTPUT,
    "totalTokens": INVESTIGATION_INPUT + INVESTIGATION_OUTPUT,
}


def _tables() -> None:
    """Create the cases + audit tables in moto and seed the IN_PROGRESS case row.

    :returns: None.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "status", "AttributeType": "S"},
            {"AttributeName": "created_at", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "status-index",
                "KeySchema": [
                    {"AttributeName": "status", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
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
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    cases.open(ITEM, status=CaseStatus.PENDING, tier=2)
    cases.transition("item_id", ITEM.item_id, CaseStatus.IN_PROGRESS)


def _drive(
    *,
    samples: int = 3,
    caller=None,
    investigation_usage: dict | None = INVESTIGATION_USAGE,
    model_id: str = BLUEPRINT_DEFAULT_MODEL,
    threshold: float | None = None,
) -> tuple[str, bool]:
    """Replay one whole runtime invocation — k classification samples then the investigation loop.

    Mirrors ``agent.handler``'s assembly step for step, including the single ``usages`` list both
    writers append to, so a call site that forgets to record its usage fails here.

    :param samples: k, the number of self-consistency samples.
    :param caller: the classification seam; a default ``_SampleCaller`` when None.
    :param investigation_usage: the investigation loop's ``accumulated_usage``.
    :param model_id: the resolved model id handed to both the calls and the persist.
    :param threshold: the auto-resolve threshold. ``None`` (the default) disables the autonomous
        write, so the case stops at PROPOSED after a single persist.
    :returns: ``(execution outcome, whether the case auto-resolved)``.
    """
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    usages: list[dict] = []
    vote = classify_with_consistency(
        model_id=model_id,
        system="policy",
        item=ITEM,
        catalog=CATALOG,
        samples=samples,
        caller=caller or _SampleCaller(),
    )
    usages.extend(vote.usages)
    prop = build_proposal(
        item=ITEM,
        classification=pick_class(
            catalog=CATALOG, fake_llm=lambda _cat: (vote.name, vote.reasoning)
        ),
        fake_investigate=make_strands_investigator(
            model_id=model_id,
            system="policy",
            tool_caller=_tool_caller,
            agent_factory=_investigation_factory(usage=investigation_usage),
            usages=usages,
        ),
        skills=SKILLS,
    )
    score_by_evidence(
        prop=prop, skills=SKILLS, observed_tools=observed_tools_from(steps=prop.steps)
    )
    return persist_and_execute(
        cases=cases,
        proposal=prop,
        usages=usages,
        model_id=model_id,
        threshold=threshold,
        invoker=lambda _action: {"status": "Cancelled"},
    )


def _stored_usage():
    """Read the persisted ``token_usage`` attribute off the case row.

    Asserted at the DynamoDB row rather than on the in-memory Proposal on purpose: the value has to
    survive ``persist_proposal``'s explicit attribute list and boto3's type rules, and an in-process
    assertion would pass against a proposal whose usage never reached storage.

    :returns: the stored dict, or None when the run measured nothing.
    """
    row = (
        boto3.resource("dynamodb", region_name="us-east-1")
        .Table("recon-cases")
        .get_item(Key={"item_id": ITEM.item_id})["Item"]
    )
    return row.get("token_usage")


@mock_aws
@pytest.mark.parametrize(
    ("samples", "expected_input", "expected_output"),
    [
        # k=1 — the single-sample configuration, which is where a "read the investigation's report"
        # bug is LEAST visible (one sample is the smallest possible under-count). 100 + 5000; 10 + 400.
        (1, 5100, 410),
        # (100 + 200) + 5000 = 5300; (10 + 20) + 400 = 430.
        (2, 5300, 430),
        # The shipped default. (100 + 200 + 300) + 5000 = 5600, NOT 5000 (investigation only) and NOT
        # 5300 (last sample plus the investigation). (10 + 20 + 30) + 400 = 460.
        (3, 5600, 460),
        # (100 + 200 + 300 + 400 + 500) + 5000 = 6500; (10 + 20 + 30 + 40 + 50) + 400 = 550.
        (5, 6500, 550),
    ],
)
def test_every_classification_sample_and_the_investigation_are_all_summed(
    samples: int, expected_input: int, expected_output: int
) -> None:
    """k+1 model calls, one stored total — the regression guard for reading only one of them.

    :param samples: k, the number of self-consistency samples drawn.
    :param expected_input: the summed input tokens across all k+1 calls.
    :param expected_output: the summed output tokens across all k+1 calls.
    :returns: None.
    """
    _tables()
    outcome, resolved = _drive(samples=samples)
    assert (outcome, resolved) == ("escalated", False)  # threshold disabled

    stored = _stored_usage()
    assert stored["input_tokens"] == Decimal(expected_input)
    assert stored["output_tokens"] == Decimal(expected_output)
    assert stored["backend"] == "runtime"
    assert stored["model_id"] == BLUEPRINT_DEFAULT_MODEL
    # Derivable from the two above, and a stored copy could come to disagree with them.
    assert "total_tokens" not in stored


def test_classify_with_consistency_returns_every_samples_usage_beside_the_vote() -> None:
    """The new return contract, asserted directly rather than only through what gets stored.

    ``usages`` is one entry PER SAMPLE, in call order — not one dict describing the last sample. The
    per-sample values are asserted individually, because a list of the right LENGTH carrying k copies
    of the final sample's counts would sum to the wrong total while looking correct.

    :returns: None.
    """
    vote = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, samples=3, caller=_SampleCaller()
    )
    assert isinstance(vote, ClassificationVote)
    assert vote.name == "record-match-review"
    assert vote.reasoning.startswith("sample ")
    assert [u["inputTokens"] for u in vote.usages] == [100, 200, 300]
    assert [u["outputTokens"] for u in vote.usages] == [10, 20, 30]


def test_the_old_two_tuple_destructuring_no_longer_silently_binds() -> None:
    """A widened tuple would have bound ``reasoning`` to the usage list at the un-updated call site.

    This is why the vote is a named record and not a third tuple element: the change has to be
    impossible to miss at every call site, not merely correct at the one that was remembered.

    Also why that record is a ``dataclass`` rather than a pydantic ``BaseModel`` like the container's
    other result types. A ``BaseModel`` is iterable — it yields ``(field, value)`` pairs — so this
    unpacking would raise only because the vote currently has three fields, and would start binding
    two ``(field, value)`` tuples the day one was removed. ``TypeError`` here is unconditional.

    :returns: None.
    """
    vote = classify_with_consistency(
        model_id="m", system="s", item=ITEM, catalog=CATALOG, samples=1, caller=_SampleCaller()
    )
    with pytest.raises(TypeError, match="non-iterable"):
        _name, _reasoning = vote  # noqa: F841 - the unpacking itself is the assertion


def test_the_token_cap_retry_records_both_attempts() -> None:
    """A reply truncated at the cap was still billed; the retry is a SECOND billed call.

    ``strands_json`` retries once with a doubled cap, so a run that had to retry is the expensive one
    — precisely the one a single returned usage would have under-reported. Both attempts must land in
    the sink.

    :returns: None.
    """
    replies = [
        ('{"name": "record-match-review", "reasoning": "cut off', "max_tokens", {"inputTokens": 7}),
        ('{"name": "record-match-review", "reasoning": "short"}', "end_turn", {"inputTokens": 11}),
    ]
    usages: list[dict] = []
    strands_json(
        model_id="m",
        system="s",
        prompt="p",
        caller=lambda **_kw: replies.pop(0),
        usages=usages,
    )
    assert [u["inputTokens"] for u in usages] == [7, 11]


@mock_aws
def test_cache_keys_no_call_reported_stay_absent_from_the_row() -> None:
    """Absence propagates: a provider that reported no cache figures must not gain zeroed ones.

    "This run had no cache hits" and "this provider does not report cache figures" are different
    facts, and a stored 0 makes them indistinguishable on the case screen.

    :returns: None.
    """
    _tables()
    _drive(samples=3)
    stored = _stored_usage()
    assert stored["input_tokens"] == Decimal(5600)
    assert "cache_read_tokens" not in stored
    assert "cache_write_tokens" not in stored


@mock_aws
def test_cache_reads_reported_by_only_some_calls_are_summed_over_those_calls() -> None:
    """The mixed case end to end: two of three samples report cache reads, nothing reports writes.

    :returns: None.
    """
    _tables()
    _drive(samples=3, caller=_SampleCaller(cache_read_on=(1, 3)))
    stored = _stored_usage()
    assert stored["cache_read_tokens"] == Decimal(8192)  # 4096 + 4096, not 4096
    # Still absent, on the same row that DOES carry cache reads — so the key is created per key, not
    # per report.
    assert "cache_write_tokens" not in stored


@mock_aws
def test_a_run_that_measured_nothing_stores_none_rather_than_zeros() -> None:
    """No usage anywhere ⇒ ``None``, never a dict of zeros.

    Zeros would render as a run that cost nothing, which is a claim about the RUN rather than about
    the measurement.

    :returns: None.
    """
    _tables()
    _drive(samples=3, caller=_SampleCaller(report_usage=False), investigation_usage=None)
    assert _stored_usage() is None


@mock_aws
def test_an_auto_resolved_case_carries_its_token_usage() -> None:
    """The cases nobody ever reviews are the ones that would otherwise have no cost figure.

    ``maybe_auto_resolve`` transitions the case to RESOLVED without re-attaching the proposal, so the
    usage an auto-resolved case carries is whatever the writes BEFORE the gate stored. Attaching it
    after the gate — or passing it as an argument to only the first persist — leaves exactly this
    class of case unpriced, and nothing on the case screen would show the gap because a resolved case
    is not looked at.

    :returns: None.
    """
    _tables()
    outcome, resolved = _drive(samples=3, threshold=0.5)
    assert (outcome, resolved) == ("executed", True)
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    assert cases.status(ITEM.item_id) == CaseStatus.RESOLVED

    stored = _stored_usage()
    assert stored["input_tokens"] == Decimal(5600)  # (100 + 200 + 300) + 5000
    assert stored["output_tokens"] == Decimal(460)  # (10 + 20 + 30) + 400
    assert stored["backend"] == "runtime"


@mock_aws
def test_the_execute_step_re_persist_does_not_drop_the_usage() -> None:
    """The proposal is written TWICE on the executed path; the second write must not blank the field.

    The second ``persist_proposal`` exists to store the ``execute`` trace step appended after the
    gated write. It re-sends every attribute, so a usage carried as a call argument rather than on the
    Proposal would revert to NULL here — with the case screen showing an executed, resolved case whose
    cost is unknown. Both the execute step and the usage are asserted on the same row, so the test
    fails if either the re-persist stops happening or it stops carrying the value.

    :returns: None.
    """
    _tables()
    _drive(samples=2, threshold=0.5)
    row = (
        boto3.resource("dynamodb", region_name="us-east-1")
        .Table("recon-cases")
        .get_item(Key={"item_id": ITEM.item_id})["Item"]
    )
    assert [s for s in row["steps"] if s.get("kind") == "execute"]
    assert row["token_usage"]["input_tokens"] == Decimal(5300)  # (100 + 200) + 5000


@mock_aws
def test_the_stored_model_id_is_the_one_the_container_resolved(monkeypatch) -> None:
    """The label follows the operator's LIVE selection, not the deploy-time environment default.

    The model is switchable from the Config tab at any time (SSM, read per invocation), and the usage
    is priced against this id later — so a hard-coded default would misprice every run made after such
    a switch, with nothing downstream able to detect it. The id therefore comes from the same resolver
    the entrypoint uses, and the assertion below is what fails if someone reintroduces a default.

    :param monkeypatch: pytest env patcher.
    :returns: None.
    """

    class _Ssm:
        """SSM stand-in holding the operator's selection."""

        def get_parameter(self, Name):
            """:returns: the selected model id, in the shape ``get_agent_model_id`` reads."""
            return {"Parameter": {"Value": OPERATOR_SELECTED_MODEL}}

    _tables()
    # Both env vars the resolver reads, so the test does not depend on the ambient environment: the
    # deployed default has to be PRESENT and different for the final assertion to mean anything.
    monkeypatch.setenv("AGENT_MODEL_PARAM", "/recon/agent-model")
    monkeypatch.setenv("MODEL_ID", BLUEPRINT_DEFAULT_MODEL)
    resolved = resolve_model_id(ssm=_Ssm())

    _drive(samples=1, model_id=resolved)
    stored = _stored_usage()
    assert stored["model_id"] == OPERATOR_SELECTED_MODEL
    # The assertion that fails on a reintroduced default: the deployed fallback is what a hard-coded
    # id would have stored, and it is a legal value — so only comparing against it catches the swap.
    assert stored["model_id"] != BLUEPRINT_DEFAULT_MODEL


def test_persist_and_execute_has_no_default_model_id() -> None:
    """A default is the mechanism by which a mislabelled run would go unnoticed, so there is none.

    Asserted on the signature because the only production caller (``agent.handler``) is live wiring
    that no unit test executes; without this, deleting the ``model_id=`` argument there would surface
    only as mispriced production data. Mirrors the harness's identical guard on
    ``worker.run_investigation``.

    :returns: None.
    """
    param = inspect.signature(persist_and_execute).parameters["model_id"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    assert param.default is inspect.Parameter.empty
