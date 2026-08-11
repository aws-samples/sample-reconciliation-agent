"""submit_proposal intake: classification thresholds, reference derivation (0/1/>1), composite,
Decimal-safe persist, and the execute/escalate decision."""

import boto3
import pytest
from moto import mock_aws

from backend.harness_agent import intake
from backend.harness_agent.stream import StreamResult
from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import ReconItem

CATALOG = [
    {"name": "document-cross-reference", "confidence_threshold": 0.7},
    {"name": "unknown", "confidence_threshold": 0.0},
]

ITEM = ReconItem(
    item_id="idp-1", domain="loan-servicing",
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
        "classification_confidence": 0.9,
        "resolution": "Mark the draw cancelled.",
        "verbalized_confidence": 0.8,
        "status": "Cancelled",
        "reason": "DRAW DATE PUSHED",
        "evidence": ["reference: DDTL-A-0001"],
    }
    base.update(overrides)
    return base


def test_derive_reference_single_match():
    assert intake.derive_reference({"search_ledger": [{"rows": [{"reference": "R1"}]}]}) == "R1"


def test_derive_reference_none_when_zero_or_multiple():
    assert intake.derive_reference({"search_ledger": [{"rows": []}]}) is None
    assert intake.derive_reference(
        {"search_ledger": [{"rows": [{"reference": "R1"}, {"reference": "R2"}]}]}
    ) is None


def test_derive_reference_parses_live_json_string_result():
    """The LIVE gateway returns MCP results as text parts, so tool_outputs holds JSON *strings*,
    not dicts. Previously this yielded zero refs → proposed_action=None → every clean single-match
    case escalated at any confidence. The string must be parsed to recover the reference."""
    live = '{"rows": [{"reference": "MF-ECF-0915"}], "count": 1}'
    assert intake.derive_reference({"search_ledger": [live]}) == "MF-ECF-0915"


def test_derive_reference_ignores_unparseable_string_result():
    """A non-JSON string result is skipped (fail-soft), not crashed on."""
    assert intake.derive_reference({"search_ledger": ["(no result payload)"]}) is None


def test_build_proposal_json_string_ledger_produces_executable_action():
    """End-to-end: a JSON-string search_ledger result (live shape) still yields an executable
    action — the regression that blocked auto-resolution for the 98%-confidence clean match."""
    sr = StreamResult()
    sr.tool_outputs["search_ledger"] = ['{"rows": [{"reference": "DDTL-A-0001"}], "count": 1}']
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=sr,
        catalog=CATALOG, idp_classification_confidence=0.95,
    )
    assert prop.proposed_action is not None
    assert prop.proposed_action["reference"] == "DDTL-A-0001"


def test_build_proposal_single_ref_produces_executable_action():
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG, idp_classification_confidence=0.95,
    )
    assert prop.proposed_action["reference"] == "DDTL-A-0001"
    assert prop.proposed_action["status"] == "Cancelled"
    assert prop.class_id == "document-cross-reference"
    # classification_confidence surfaced = the MODEL's own value (parity with the runtime, which
    # always surfaces the model's classification confidence). IDP's 0.95 anchors the COMPOSITE
    # below only — it is not the displayed classification confidence.
    assert prop.classification_confidence == 0.9
    # Unified weights (identical to runtime): 0.45*idp(0.95) + 0.35*grounding(1.0) + 0.20*0.8
    # = 0.4275 + 0.35 + 0.16 = 0.9375
    assert prop.confidence == pytest.approx(0.9375)


def test_build_proposal_multiple_refs_forces_no_action():
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=_stream_with_ledger(["R1", "R2"]),
        catalog=CATALOG, idp_classification_confidence=0.95,
    )
    assert prop.proposed_action is None  # ambiguous ledger match ⇒ nothing safely executable


def test_build_proposal_below_class_threshold_becomes_unknown():
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(classification_confidence=0.5),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]), catalog=CATALOG,
        idp_classification_confidence=None,
    )
    assert prop.class_id == "unknown"


def test_build_proposal_idp_absent_renormalizes_composite():
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG, idp_classification_confidence=None,
    )
    # IDP absent → renormalize the other two identically to runtime: grounding 0.35/0.55,
    # verbalized 0.20/0.55 → (0.35/0.55)*1.0 + (0.20/0.55)*0.8 = 0.63636 + 0.29091 = 0.92727
    assert prop.confidence == pytest.approx(1.0 * (0.35 / 0.55) + 0.8 * (0.20 / 0.55))


def test_build_proposal_missing_resolution_and_reason_raises():
    """Fail loud only when there is NO resolution AND no `reason` to recover it from."""
    with pytest.raises(ValueError, match="resolution"):
        intake.build_proposal(
            item=ITEM, submitted=_submitted(resolution="", reason=""),
            stream_result=_stream_with_ledger(["DDTL-A-0001"]), catalog=CATALOG,
            idp_classification_confidence=0.9,
        )


def test_build_proposal_aliases_resolution_from_reason():
    """When `resolution` is missing but `reason` is present, reuse `reason` as the resolution
    narrative instead of hard-failing — the model frequently drops `resolution` while supplying
    `reason` (observed live 2026-07-27). `reason` still remains for the proposed_action."""
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(resolution="", reason="Excess-cash-flow prepayment applied."),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]), catalog=CATALOG,
        idp_classification_confidence=0.95,
    )
    assert prop.resolution == "Excess-cash-flow prepayment applied."  # recovered from `reason`
    assert prop.class_id == "document-cross-reference"  # classification preserved, not unknown
    assert prop.proposed_action["reason"] == "Excess-cash-flow prepayment applied."  # reason kept


def test_build_proposal_classification_confidence_prefers_model_value():
    """The displayed classification_confidence is the MODEL's own value even when IDP's class
    confidence is present — parity with the runtime backend. IDP still feeds the composite."""
    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(classification_confidence=0.82),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]), catalog=CATALOG,
        idp_classification_confidence=0.95,
    )
    assert prop.classification_confidence == 0.82  # model's, not IDP's 0.95


def test_build_proposal_classification_confidence_falls_back_to_verbalized():
    """The "Unclassified/0" fix: when the model omits classification_confidence AND there is no
    IDP class confidence, surface the overall verbalized confidence rather than a bare 0 — the
    runtime always has a non-zero classification signal (self-consistency), so the harness must
    not display 0 for a case that produced a real proposal."""
    prop = intake.build_proposal(
        item=ITEM,
        submitted=_submitted(classification_confidence=None, verbalized_confidence=0.8),
        stream_result=_stream_with_ledger(["DDTL-A-0001"]), catalog=CATALOG,
        idp_classification_confidence=None,
    )
    assert prop.class_id == "unknown"  # no class confidence ⇒ below threshold ⇒ unknown
    assert prop.classification_confidence == 0.8  # verbalized fallback, NOT 0


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


def test_build_proposal_json_string_evidence_does_not_corrupt_grounding():
    """A JSON-string evidence must yield a clean evidence list + a sane grounding fraction."""
    # ITEM's ledger side has reference DDTL-A-0001; evidence cites it as a JSON STRING.
    submitted = _submitted(evidence='["reference: DDTL-A-0001"]')
    prop = intake.build_proposal(
        item=ITEM, submitted=submitted, stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG, idp_classification_confidence=0.95,
    )
    propose = next(s for s in prop.steps if s.kind == "propose")
    # Evidence is a clean 1-element list, NOT a char-per-element explosion.
    assert propose.evidence == ["reference: DDTL-A-0001"]
    # Grounding is a clean fraction over the real evidence item (grounded → 1.0), not a
    # long non-round decimal from a ~700-char denominator.
    assert prop.confidence_components["grounding"] == pytest.approx(1.0)


def test_decide_execute_vs_escalate():
    executable = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG, idp_classification_confidence=0.95,
    )
    assert intake.decide(proposal=executable, threshold=0.9)["decision"] == "execute"
    assert intake.decide(proposal=executable, threshold=0.99)["decision"] == "escalate"  # below t
    no_action = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=_stream_with_ledger([]),
        catalog=CATALOG, idp_classification_confidence=0.95,
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
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"},
                   {"AttributeName": "ts", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"},
                              {"AttributeName": "ts", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    # Seed IN_PROGRESS so the PROPOSED transition is allowed.
    ddb.Table("recon-cases").put_item(Item={"item_id": "idp-1", "status": "IN_PROGRESS"})

    prop = intake.build_proposal(
        item=ITEM, submitted=_submitted(), stream_result=_stream_with_ledger(["DDTL-A-0001"]),
        catalog=CATALOG, idp_classification_confidence=0.95,
    )
    intake.persist(cases=cases, proposal=prop)

    row = ddb.Table("recon-cases").get_item(Key={"item_id": "idp-1"})["Item"]
    assert row["status"] == "PROPOSED"
    assert row["proposed_action"]["reference"] == "DDTL-A-0001"
    assert row["class_id"] == "document-cross-reference"
