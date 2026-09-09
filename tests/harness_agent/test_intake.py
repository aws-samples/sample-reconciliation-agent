"""submit_proposal intake: classification by catalog membership, reference derivation (0/1/>1),
the evidence-completeness score, Decimal-safe persist, and the execute/escalate decision.

There is no classification threshold and no composite any more — both were deleted on 2026-09-04
along with every model-reported confidence number."""

import logging
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.harness_agent import intake
from backend.harness_agent.stream import StreamResult
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import EvidenceStep, ReconItem

# `evidence_steps` is the DENOMINATOR of the proposal's confidence, so it belongs in the shared
# catalog: two required steps here means `_submitted()`'s one-of-two report scores 0.5. `unknown`
# declares none, which is the unscoreable classification fallback (score 0.0, always escalates).
CATALOG = [
    {
        "name": "document-cross-reference",
        "confidence_threshold": 0.7,
        "evidence_steps": [
            EvidenceStep(id="ledger_hit", description="the matching ledger entry"),
            EvidenceStep(id="notice_hit", description="the notice behind the break"),
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


def _stream_with_ledger(refs):
    """A StreamResult whose search_ledger recorded rows carry the given references."""
    sr = StreamResult()
    sr.tool_outputs["search_ledger"] = [{"rows": [{"reference": r} for r in refs]}]
    return sr


def _submitted(**overrides):
    base = {
        "class_name": "document-cross-reference",
        "classification_reasoning": "draw cancellation notice",
        "resolution": "Mark the draw cancelled.",
        "status": "Cancelled",
        "reason": "DRAW DATE PUSHED",
        "evidence": ["reference: DDTL-A-0001"],
        # One of the two required steps obtained data => the default proposal scores 0.5.
        "evidence_steps": [
            {"step_id": "ledger_hit", "satisfied": True},
            {"step_id": "notice_hit", "satisfied": False},
        ],
    }
    base.update(overrides)
    return base


def test_derive_reference_single_match():
    assert intake.derive_reference({"search_ledger": [{"rows": [{"reference": "R1"}]}]}) == "R1"


def test_derive_reference_none_when_zero_or_multiple():
    assert intake.derive_reference({"search_ledger": [{"rows": []}]}) is None
    assert (
        intake.derive_reference(
            {"search_ledger": [{"rows": [{"reference": "R1"}, {"reference": "R2"}]}]}
        )
        is None
    )


def test_derive_reference_parses_live_json_string_result():
    """The LIVE gateway returns MCP results as text parts, so tool_outputs holds JSON *strings*, not
    dicts. Treating them as dicts yields zero refs → proposed_action=None → every clean single-match
    case escalates at any confidence. The string must be parsed to recover the reference."""
    live = '{"rows": [{"reference": "MF-ECF-0915"}], "count": 1}'
    assert intake.derive_reference({"search_ledger": [live]}) == "MF-ECF-0915"


def test_derive_reference_ignores_unparseable_string_result():
    """A non-JSON string result is skipped (fail-soft), not crashed on."""
    assert intake.derive_reference({"search_ledger": ["(no result payload)"]}) is None


def test_proposed_action_cites_the_single_matched_notice() -> None:
    outputs = {
        "search_ledger": [{"rows": [{"reference": "REF-1"}]}],
        "search_notices": [{"rows": [{"notice_id": "NTC-20260302-0001"}]}],
    }
    assert intake.derive_notice_id(outputs) == "NTC-20260302-0001"


def test_two_distinct_notices_cite_none() -> None:
    # Ambiguous evidence must not silently pick one. None means the interceptor's "no notice cited"
    # branch applies, and a write is then gated only by provenance — which is why the auto-resolve
    # gate forbids resolving an uncited notice-class proposal.
    outputs = {"search_notices": [{"rows": [{"notice_id": "a"}, {"notice_id": "b"}]}]}
    assert intake.derive_notice_id(outputs) is None


def test_notice_id_survives_a_json_string_tool_result() -> None:
    # Live gateway results arrive as JSON text parts, not dicts — the same shape hazard
    # derive_reference already handles via _as_result_dict.
    outputs = {"search_notices": ['{"rows": [{"notice_id": "n9"}]}']}
    assert intake.derive_notice_id(outputs) == "n9"


def test_build_proposal_json_string_ledger_produces_executable_action():
    """End-to-end: a JSON-string search_ledger result (live shape) still yields an executable
    action — the regression that blocked auto-resolution for the 98%-confidence clean match."""
    sr = StreamResult()
    sr.tool_outputs["search_ledger"] = ['{"rows": [{"reference": "DDTL-A-0001"}], "count": 1}']
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=sr,
        catalog=CATALOG,
    )
    assert prop.proposed_action is not None
    assert prop.proposed_action["reference"] == "DDTL-A-0001"


def test_build_proposal_single_ref_produces_executable_action():
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    assert prop.proposed_action["reference"] == "DDTL-A-0001"
    assert prop.proposed_action["status"] == "Cancelled"
    assert prop.class_id == "document-cross-reference"
    # 1 of the skill's 2 required evidence steps obtained data — the whole of the score. The model is
    # no longer asked for any number about itself, so there is nothing else that could enter it.
    assert prop.confidence == pytest.approx(0.5)


def test_build_proposal_multiple_refs_forces_no_action():
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger(["R1", "R2"]),
        catalog=CATALOG,
    )
    assert prop.proposed_action is None  # ambiguous ledger match ⇒ nothing safely executable


def test_harness_reports_become_trace_steps_and_drive_the_score():
    """The reports land on the trace, in submission order, and are what the score is computed from."""
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    assert prop.confidence == pytest.approx(0.5)
    reported = [(s.step_id, s.satisfied) for s in prop.steps if s.kind == "evidence_step"]
    assert reported == [("ledger_hit", True), ("notice_hit", False)]
    assert prop.confidence_components["unsatisfied_step_ids"] == ["notice_hit"]


def test_a_satisfied_step_with_no_recorded_tool_call_is_downgraded():
    """The report is the model's claim; the recorded tool calls are what happened.

    An investigation that made no data-returning call cannot have obtained data, whatever it reports.
    Without this the score is the model's word about the model's work, and the honest-reporting
    instruction in the submit schema is the only thing between a confident claim and a
    straight-through ledger write."""
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(evidence_steps=[{"step_id": "ledger_hit", "satisfied": True}]),
        stream_result=StreamResult(),  # no tool calls at all
        catalog=CATALOG,
    )
    assert prop.confidence == 0.0
    # Downgraded to unattempted, not to "attempted and empty" — the agent never looked.
    assert prop.confidence_components["unattempted_step_ids"] == ["ledger_hit", "notice_hit"]
    assert prop.confidence_components["unsatisfied_step_ids"] == []


def test_the_same_claim_stands_once_a_tool_actually_returned():
    """Control for the test above: identical report, one real lookup behind it."""
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(evidence_steps=[{"step_id": "ledger_hit", "satisfied": True}]),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    assert prop.confidence == pytest.approx(0.5)


def test_an_unclassifiable_item_is_unscoreable_rather_than_a_crash():
    """`unknown` declares no evidence steps, so there is nothing to evidence: 0.0 and escalate.

    Reached here by naming a break type the catalog does not have — which is now the ONLY way to get
    ``unknown``. It used to also be reachable with a self-reported confidence under the floor, and
    that path is what made a well-evidenced case unscoreable on the model's own say-so.
    """
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(class_name="a-type-the-catalog-does-not-have"),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    assert prop.class_id == "unknown"
    assert prop.confidence == 0.0
    assert "declares no evidence_steps" in prop.confidence_components["unscoreable"]


def test_build_proposal_missing_resolution_and_reason_raises():
    """Fail loud only when there is NO resolution AND no `reason` to recover it from."""
    with pytest.raises(ValueError, match="resolution"):
        intake.build_proposal(
            item=ITEM,
            submitted=_submitted(resolution="", reason=""),
            stream_result=_stream_with_ledger(["DDTL-A-0001"]),
            catalog=CATALOG,
        )


def test_build_proposal_aliases_resolution_from_reason():
    """When `resolution` is missing but `reason` is present, reuse `reason` as the resolution
    narrative instead of hard-failing — the model frequently drops `resolution` while supplying
    `reason` (observed live 2026-07-27). `reason` still remains for the proposed_action."""
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(resolution="", reason="Excess-cash-flow prepayment applied."),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    assert prop.resolution == "Excess-cash-flow prepayment applied."  # recovered from `reason`
    assert prop.class_id == "document-cross-reference"  # classification preserved, not unknown
    assert prop.proposed_action["reason"] == "Excess-cash-flow prepayment applied."  # reason kept


def test_a_known_class_survives_a_low_model_confidence():
    """Backend parity with ``classifier.pick_class`` (which lost its floor in the same change).

    Until 2026-09-04 a self-reported 0.5 rewrote the class to ``unknown``, which declares no
    evidence_steps — so a fully-evidenced case scored 0.0 and could not auto-resolve. On 2026-09-02
    that hit every harness case at once, because the tool schema had the field as optional and an
    absent value read as 0.0.
    """
    class_id, reasoning = intake.classify_submitted(
        submitted={
            "class_name": "document-cross-reference",
            "classification_confidence": 0.5,
            "classification_reasoning": "why",
        },
        catalog=CATALOG,
    )
    assert class_id == "document-cross-reference"
    assert reasoning == "why"


def test_a_proposal_without_a_verbalized_confidence_is_valid():
    """It was a REQUIRED field of submit_proposal that nothing scored.

    So a model that investigated well but omitted it lost the whole proposal to a ValueError and the
    item escalated on a missing number rather than on missing evidence.
    """
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(verbalized_confidence=None),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    assert prop.resolution  # no ValueError
    assert prop.confidence == pytest.approx(0.5)  # scored on evidence, as before


def test_a_stale_prompt_still_reporting_a_confidence_cannot_set_the_score():
    """The deploy window, on the backend that is easiest to get wrong.

    Both system prompts are create-only S3 objects, so this code ships BEFORE the rewritten prompt
    does (the seed push is a separate manual step). Until it lands the live model is still told to
    report a confidence, and the harness does not enforce the inline function's argument schema — so
    whatever it sends arrives in ``submitted`` regardless of the schema no longer declaring it.

    ``build_proposal`` assembles ``Proposal`` field by field and never splats ``submitted``, which is
    what makes that window harmless. Asserted here because the failure mode of losing that property
    is silent and maximally bad: a refactor to ``Proposal(**submitted)`` would hand the model the
    auto-resolve gate's own key, and a 0.99 self-report would clear the 0.85 threshold on a proposal
    that satisfied one required step out of two.
    """
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(
            confidence=0.99,
            verbalized_confidence=0.99,
            classification_confidence=0.99,
            confidence_components={"verbalized": 0.99},
        ),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )

    assert prop.confidence == pytest.approx(0.5)  # 1 of 2 required steps, as the evidence says
    assert "verbalized" not in (prop.confidence_components or {})
    # And nothing the model said about itself reached the trace either.
    assert all(s.confidence is None for s in prop.steps)


def test_coerce_evidence_handles_json_string_without_char_explosion():
    """Regression: a JSON-STRING evidence must decode to a list, NOT explode into characters."""
    # The observed live corruption: model emitted evidence as a JSON-encoded string.
    raw = '["issuer: Cindermoor Logistics Holdings, Inc.", "facility: 2023 Delayed Draw"]'
    out = intake._coerce_evidence(raw)
    assert out == ["issuer: Cindermoor Logistics Holdings, Inc.", "facility: 2023 Delayed Draw"]
    # A real list passes through; a plain string is ONE item (never split into chars).
    assert intake._coerce_evidence(["a", "b"]) == ["a", "b"]
    assert intake._coerce_evidence("reference: DDTL-A-0001") == ["reference: DDTL-A-0001"]
    assert intake._coerce_evidence(None) == []
    assert intake._coerce_evidence("") == []


def test_build_proposal_json_string_evidence_reaches_the_trace_intact():
    """A JSON-string evidence must land on the propose step as one item, not one item per character."""
    # ITEM's ledger side has reference DDTL-A-0001; evidence cites it as a JSON STRING.
    submitted = _submitted(evidence='["reference: DDTL-A-0001"]')
    prop = intake.build_proposal(
        item=ITEM,
        submitted=submitted,
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    propose = next(s for s in prop.steps if s.kind == "propose")
    # A clean 1-element list, NOT a char-per-element explosion. The live symptom was the case screen
    # rendering one bordered evidence box per letter.
    assert propose.evidence == ["reference: DDTL-A-0001"]


def test_decide_execute_vs_escalate():
    executable = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    # `_submitted()` scores 0.5 (1 of 2 required steps).
    assert intake.decide(proposal=executable, threshold=0.4)["decision"] == "execute"
    assert intake.decide(proposal=executable, threshold=0.6)["decision"] == "escalate"  # below t
    no_action = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger([]),
        catalog=CATALOG,
    )
    assert intake.decide(proposal=no_action, threshold=0.1)["decision"] == "escalate"  # no action


@mock_aws
def test_persist_writes_decimal_safe_and_transitions(monkeypatch):
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(  # audit table keyed item_id (HASH) + ts (RANGE), per CaseStore._audit_row
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
    # Seed IN_PROGRESS so the PROPOSED transition is allowed.
    ddb.Table("recon-cases").put_item(Item={"item_id": "idp-1", "status": "IN_PROGRESS"})

    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    intake.persist(cases=cases, proposal=prop)

    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"
    assert row["proposed_action"]["reference"] == "DDTL-A-0001"
    assert row["class_id"] == "document-cross-reference"
    # Written even when the investigation ran no notice search — `searched: False` is what tells the
    # panel to render nothing, as distinct from an absent attribute (a case persisted before this
    # attribute existed, which has to fall back to the trace).
    assert row["notice_search"]["searched"] is False


@mock_aws
def test_persist_writes_the_full_notice_rows_untruncated(monkeypatch):
    """The rows the panel renders reach DynamoDB whole, floats and all.

    Regression: the only stored copy used to be the trace's 600-character `tool_output`, which cut a
    notice row mid-string. The UI parsed that fragment, failed, and reported "matched no notices".
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
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    ddb.Table("recon-cases").put_item(Item={"item_id": "idp-1", "status": "IN_PROGRESS"})

    sr = _stream_with_ledger(["DDTL-A-0001"])
    # A float amount and a float confidence: boto3 rejects raw floats, so this also covers the
    # Decimal conversion on the way in.
    sr.tool_outputs["search_notices"] = [
        {
            "rows": [
                {
                    "notice_id": "idp-02-PAYDOWN-V11",
                    "amount": 12500.0,
                    "extraction_confidence": 0.98825,
                    "notes": "y" * 700,
                }
            ],
            "matched_on": ["amount"],
        }
    ]

    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=sr, catalog=CATALOG
    )
    intake.persist(cases=cases, proposal=prop)

    stored = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]["notice_search"]
    assert stored["searched"] is True
    assert stored["matched_on"] == ["amount"]
    assert stored["omitted"] == 0
    assert len(stored["rows"]) == 1
    # The long field survives whole — the trace summary would have cut it at 600 characters.
    assert len(stored["rows"][0]["notes"]) == 700
    assert stored["rows"][0]["amount"] == Decimal("12500.0")


@mock_aws
def test_an_evidence_step_persists_its_step_id_and_a_false_satisfied():
    """Mirror of the runtime backend's test — neither allowlist may regress alone.

    ``intake.persist`` builds the stored step dict from its own explicit key list, so a field added
    to ``ReasoningStep`` reaches DynamoDB on one backend and not the other unless both are covered.
    """
    from backend.recon_core.schema import ReasoningStep

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
    cases = CaseStore(table="recon-cases", audit="recon-audit")

    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG,
    )
    prop.steps.insert(
        0,
        ReasoningStep(
            skill="s",
            reasoning="looked, found nothing",
            kind="evidence_step",
            step_id="ledger_hit",
            satisfied=False,
        ),
    )
    prop.steps.insert(
        1,
        ReasoningStep(
            skill="s",
            reasoning="skipped",
            kind="evidence_step",
            step_id="notice_hit",
        ),
    )
    intake.persist(cases=cases, proposal=prop)

    steps = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]["steps"]
    assert steps[0]["step_id"] == "ledger_hit"
    # `is False`, not falsy — see the runtime mirror in tests/recon_agent/test_agent_persist.py.
    assert steps[0]["satisfied"] is False
    assert steps[1]["step_id"] == "notice_hit"
    assert "satisfied" not in steps[1]  # never attempted -> key absent, not false
    # Mirror of the runtime assertion: gone from STORAGE, not merely from the models. `persist` puts
    # `confidence` inside its `is not None` block precisely so the key drops out — assert the effect,
    # since moving it back out would silently write `Decimal("None")`-adjacent junk or a bare 0.
    assert all("confidence" not in s for s in steps)
    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert "classification_confidence" not in row


def test_a_class_disagreeing_with_tier1_is_logged(caplog) -> None:
    """The harness mirror of the runtime test in tests/recon_agent/test_classifier.py.

    ``_classify``'s docstring promises it is identical to ``classifier.pick_class``, so a signal added
    on one backend and not the other breaks the invariant the same item classifies the same way
    whichever backend served it — and this one exists to be watched over time, which only works if
    both backends emit it.
    """
    with caplog.at_level(logging.WARNING):
        class_id, _ = intake.classify_submitted(
            submitted=_submitted(),
            catalog=CATALOG,
            tier1_hint="record-match-review",
        )
    # Tier-1 never overrules: the agent's own pick is what reaches the case record.
    assert class_id == "document-cross-reference"
    assert "record-match-review" in caplog.text


def test_agreement_with_tier1_logs_nothing(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        intake.classify_submitted(
            submitted=_submitted(),
            catalog=CATALOG,
            tier1_hint="document-cross-reference",
        )
    assert caplog.text == ""
