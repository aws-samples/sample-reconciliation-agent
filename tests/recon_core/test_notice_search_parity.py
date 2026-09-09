"""Both agent backends must persist the SAME ``notice_search`` for the same ``search_notices`` results.

This file exists because the bug it guards against already shipped. MR !48 added ``notice_search`` so
the Matched Notices panel could read the agent's own rows instead of the truncated trace summary, but
it changed only the HARNESS backend. ``CaseStore.attach_proposal`` had ``notice_search: dict | None =
None``, so the AgentCore Runtime backend — the one that actually investigated the cases — kept writing
DynamoDB ``NULL``, and the panel kept reporting "the notices this case matched cannot be shown" on
every case for a day. Nothing failed: an optional keyword argument with a ``None`` default is a silent
fallback, which is exactly what the repo's conventions forbid.

The parity is asserted backend against backend rather than each backend against a hardcoded fixture,
for the reason ``test_email_draft_parity`` gives: both can satisfy a fixture while disagreeing with
each other. And each side runs through its own ``build_proposal`` rather than calling
``notice_search_summary`` directly, so the pass-through onto ``Proposal.notice_search`` is covered too
— dropping that keyword somewhere along the chain is the failure mode, and it is invisible to a
helper-level test.
"""

import json

import pytest
from proposal import build_proposal as runtime_build_proposal
from strands_investigator import make_strands_investigator

from backend.harness_agent import intake
from backend.harness_agent.stream import StreamResult
from backend.recon_core.proposal_service import notice_search_summary
from backend.recon_core.schema import ClassificationResult, ReconItem

ITEM = ReconItem(
    item_id="idp-1",
    domain="loan-servicing",
    sides=[{"name": "ledger", "attributes": {"reference": "DDTL-A-0001"}}],
    attributes={"idp_class": "LoanDrawCancellationNotice"},
)
CLASSIFICATION = ClassificationResult(
    class_id="document-cross-reference", reasoning="draw cancellation notice"
)
CATALOG = [
    {"name": "document-cross-reference", "confidence_threshold": 0.7},
    {"name": "unknown", "confidence_threshold": 0.0},
]
# Deliberately longer than the ~600-char trace cap: a realistic notice row is what broke the old
# read-it-back-out-of-the-trace path, so the parity has to be asserted on one that size.
NOTICE_ROW = {
    "notice_id": "idp-02-INTEREST-RATESET-V11",
    "notice_class": "rateset_notice",
    "counterparty": "Cindermoor Trust Bank, N.A.",
    "facility": "CINDERMOOR LOGISTICS TL-B $250MM",
    "reference": "DDTL-A-0001",
    "amount": 12500.0,
    "currency": "USD",
    "extraction_confidence": 0.98825,
    "notes": "x" * 400,
}
NOTICE_RESULT = {"rows": [NOTICE_ROW], "matched_on": ["reference", "amount"]}


def _runtime_notice_search(notice_result: object) -> dict | None:
    """Persisted ``notice_search`` the RUNTIME backend produces for one ``search_notices`` result.

    Drives the real agentic loop with a fake agent, so the result travels the production path:
    ``_build_tools._call`` accumulation → ``_investigate`` → ``proposal.build_proposal`` →
    ``Proposal``. A ``search_ledger`` row is returned as well because without a single clean reference
    the proposal is non-executable, and this test is not about that path.

    :param notice_result: the whole result the ``search_notices`` tool returns (dict or JSON string);
        ``None`` to make the investigation never call the tool at all.
    :returns: the ``notice_search`` map on the assembled Proposal.
    """

    def tool_caller(name: str, args: dict):
        if name == "search_ledger":
            return {"rows": [{"reference": "DDTL-A-0001"}]}
        if name == "search_notices":
            return notice_result
        return {}

    def agent_factory(model_id, system_prompt, tools):
        class _Result:
            def __init__(self, text: str) -> None:
                self.message = {"role": "assistant", "content": [{"text": text}]}

        class _Agent:
            def __call__(self, prompt: str) -> "_Result":
                # Call the tools the way the real agent would; the fake's job is only to make the
                # calls happen and then emit a parseable final message.
                by_name = {getattr(t, "__name__", ""): t for t in tools}
                by_name["search_ledger"](reference="DDTL-A-0001")
                if notice_result is not None:
                    by_name["search_notices"](reference="DDTL-A-0001")
                return _Result(
                    json.dumps(
                        {
                            "resolution": "Mark the draw cancelled.",
                            "confidence": 0.8,
                            "evidence": ["reference: DDTL-A-0001"],
                            "status": "Cancelled",
                            "reason": "draw date pushed",
                        }
                    )
                )

        return _Agent()

    prop = runtime_build_proposal(
        item=ITEM,
        classification=CLASSIFICATION,
        fake_investigate=make_strands_investigator(
            model_id="m",
            system="sys",
            tool_caller=tool_caller,
            agent_factory=agent_factory,
        ),
        skills=[{"name": "document-cross-reference", "body": "Confirm against the ledger."}],
    )
    return prop.notice_search


def _harness_notice_search(notice_result: object) -> dict | None:
    """Persisted ``notice_search`` the HARNESS backend produces for the same result.

    :param notice_result: the whole ``search_notices`` result, or ``None`` for no recorded call.
    :returns: the ``notice_search`` map on the assembled Proposal.
    """
    stream = StreamResult()
    stream.tool_outputs["search_ledger"] = [{"rows": [{"reference": "DDTL-A-0001"}]}]
    if notice_result is not None:
        stream.tool_outputs["search_notices"] = [notice_result]
    prop = intake.build_proposal(
        item=ITEM,
        submitted={
            "class_name": "document-cross-reference",
            "classification_reasoning": "draw cancellation notice",
            "resolution": "Mark the draw cancelled.",
            "status": "Cancelled",
            "reason": "draw date pushed",
            "evidence": ["reference: DDTL-A-0001"],
        },
        stream_result=stream,
        catalog=CATALOG,
    )
    return prop.notice_search


def test_both_backends_persist_an_identical_notice_search():
    runtime = _runtime_notice_search(NOTICE_RESULT)
    harness = _harness_notice_search(NOTICE_RESULT)
    assert runtime == harness
    # Pin the shape too: equal-but-both-empty would satisfy the comparison above, and "both empty" is
    # precisely the state the bug produced.
    assert runtime == notice_search_summary(results=[NOTICE_RESULT])
    assert runtime["rows"] == [NOTICE_ROW]
    assert runtime["matched_on"] == ["reference", "amount"]
    # The row the panel gets is bigger than the trace cap that made it unreadable in the first place.
    assert len(json.dumps(runtime["rows"][0])) > 600


def test_neither_backend_persists_null_when_the_tool_was_called():
    """THE regression. A populated result must never come out as ``None``/``NULL`` on either backend —
    the panel reads a null as "cannot be shown" and tells the analyst the case matched nothing."""
    assert _runtime_notice_search(NOTICE_RESULT) is not None
    assert _harness_notice_search(NOTICE_RESULT) is not None
    assert _runtime_notice_search(NOTICE_RESULT)["searched"] is True


def test_both_backends_accept_the_live_gateway_json_string_shape():
    """The live gateway returns MCP results as text parts, so the runtime can see a JSON string here
    too — the same shape difference that once made every clean single-match case escalate."""
    stringified = json.dumps(NOTICE_RESULT)
    runtime = _runtime_notice_search(stringified)
    harness = _harness_notice_search(stringified)
    assert runtime == harness
    assert runtime["rows"] == [NOTICE_ROW]


def test_both_backends_report_not_searched_when_the_tool_was_never_called():
    """ "Never searched" and "searched and matched nothing" lead a reviewer to opposite conclusions, so
    the two backends must agree on which one this was."""
    runtime = _runtime_notice_search(None)
    harness = _harness_notice_search(None)
    assert runtime == harness
    assert runtime["searched"] is False and runtime["rows"] == []


def test_the_persisted_summary_is_not_what_the_verdict_reads():
    """The display record caps and de-duplicates rows; the evidence verdict must not inherit either.

    ``evidence_quality`` gates a ledger write, so if the two ever shared one derivation a display
    concern could move a decision. Asserted here rather than in the summary's own unit tests because
    it is a cross-cutting invariant about which list feeds which consumer.
    """
    from backend.recon_core import proposal_service

    duplicated = {"rows": [NOTICE_ROW, NOTICE_ROW], "matched_on": []}
    summary = proposal_service.notice_search_summary(results=[duplicated])
    # The summary de-duplicates by notice_id ...
    assert len(summary["rows"]) == 1
    # ... and the verdict, given the same raw rows, still sees both. Same input, different consumers.
    verdict, reason = proposal_service.judge_cited_evidence(
        notice_rows=duplicated["rows"], guidance_results=[]
    )
    assert verdict and reason


def test_the_required_keyword_is_what_prevents_the_recurrence():
    """``attach_proposal`` must REJECT a caller that forgets ``notice_search``.

    The parity assertions above would all have passed while the runtime backend was writing ``NULL``,
    because they run ``build_proposal``, not the persist path. This is the assertion that actually
    fails if a third caller appears and omits the argument.
    """
    from backend.recon_core.cases import CaseStore

    store = CaseStore.__new__(CaseStore)  # no AWS: the TypeError is raised at binding time
    with pytest.raises(TypeError, match="notice_search"):
        store.attach_proposal(
            item_id="idp-1",
            class_id="unknown",
            classification_reasoning="ambiguous",
            resolution="Escalate.",
            confidence=0,
            steps=[],
        )
