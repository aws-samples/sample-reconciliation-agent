"""attach_proposal persists the structured proposed_action + typed trace step fields."""

from decimal import Decimal

import boto3
from moto import mock_aws

from backend.recon_core.cases import CaseStore


@mock_aws
def test_attach_proposal_persists_action_and_typed_steps(make_case_tables, seed_case):
    make_case_tables()
    seed_case("idp-1", status="IN_PROGRESS")
    store = CaseStore(table="recon-cases", audit="recon-audit")

    store.attach_proposal(
        item_id="idp-1",
        class_id="document-cross-reference",
        classification_confidence=Decimal("0.95"),
        classification_reasoning="loan draw cancellation notice",
        resolution="Mark the draw cancelled.",
        confidence=Decimal("0.97"),
        steps=[
            {
                "skill": "search",
                "confidence": Decimal("0"),
                "reasoning": "looked up posting",
                "evidence": [],
                "kind": "tool_call",
                "tool": "search_ledger",
                "tool_input": {"reference": "DDTL-A-0001"},
                "tool_output": "1 posting found",
            },
            {
                "skill": "execute",
                "confidence": Decimal("0"),
                "reasoning": "performed the write",
                "evidence": [],
                "kind": "execute",
                "action": {"tool": "set_draw_status", "reference": "DDTL-A-0001"},
                "outcome": "executed",
            },
        ],
        confidence_components={"consistency": Decimal("1")},
        proposed_action={
            "tool": "set_draw_status",
            "reference": "DDTL-A-0001",
            "status": "Cancelled",
            "reason": "DRAW DATE HAS BEEN PUSHED",
        },
    )

    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-1"}
    )["Item"]
    assert row["proposed_action"]["reference"] == "DDTL-A-0001"
    assert row["proposed_action"]["status"] == "Cancelled"
    assert row["steps"][0]["kind"] == "tool_call"
    assert row["steps"][0]["tool"] == "search_ledger"
    assert row["steps"][1]["kind"] == "execute"
    assert row["steps"][1]["outcome"] == "executed"


@mock_aws
def test_attach_proposal_omits_action_when_none(make_case_tables, seed_case):
    make_case_tables()
    seed_case("idp-2", status="IN_PROGRESS")
    store = CaseStore(table="recon-cases", audit="recon-audit")

    store.attach_proposal(
        item_id="idp-2",
        class_id="unknown",
        classification_confidence=Decimal("0.4"),
        classification_reasoning="ambiguous",
        resolution="Escalate.",
        confidence=Decimal("0.4"),
        steps=[],
        confidence_components={},
        proposed_action=None,
    )

    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-2"}
    )["Item"]
    # A non-executable proposal stores an explicit null (never a fabricated action).
    assert row.get("proposed_action") is None
    # Same for the email draft: the caller omitted it entirely, so it must persist as null rather
    # than be absent — the interceptor's counterparty branch reads this attribute directly.
    assert row.get("proposed_email") is None


@mock_aws
def test_attach_proposal_persists_proposed_email(make_case_tables, seed_case):
    make_case_tables()
    seed_case("idp-3", status="IN_PROGRESS")
    store = CaseStore(table="recon-cases", audit="recon-audit")

    store.attach_proposal(
        item_id="idp-3",
        class_id="counterparty-contact",
        classification_confidence=Decimal("0.9"),
        classification_reasoning="missing remittance detail",
        resolution="Ask the borrower to confirm the wire reference.",
        confidence=Decimal("0.9"),
        steps=[],
        confidence_components={},
        proposed_action=None,
        proposed_email={
            "recipient": None,
            "recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.",
            "subject": "Wire reference confirmation",
            "body": "Please confirm the reference on the 2026-08-03 wire.",
            "draft_status": "pending",
            "revision": 0,
        },
    )

    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-3"}
    )["Item"]
    draft = row["proposed_email"]
    assert draft["draft_status"] == "pending"
    assert draft["subject"] == "Wire reference confirmation"
    # The recipient is resolved by a human later, never by the model — see schema.Proposal.
    assert draft["recipient"] is None
    assert draft["recipient_hint"] == "CINDERMOOR LOGISTICS HOLDINGS INC."
    # A draft and an action are independent: this case has one but not the other.
    assert row.get("proposed_action") is None


@mock_aws
def test_proposed_email_is_optional_for_every_existing_caller(make_case_tables, seed_case):
    """Every current caller omits ``proposed_email``; the parameter must stay keyword-optional.

    ``tests/recon_core/test_cases.py`` spreads a shared ``_proposal_kwargs`` helper that does not
    include it, so making it required would break the whole case suite rather than just this test.
    """
    make_case_tables()
    seed_case("idp-4", status="IN_PROGRESS")
    store = CaseStore(table="recon-cases", audit="recon-audit")

    store.attach_proposal(
        item_id="idp-4",
        class_id="unknown",
        classification_confidence=Decimal("0.4"),
        classification_reasoning="ambiguous",
        resolution="Escalate.",
        confidence=Decimal("0.4"),
        steps=[],
    )

    row = boto3.resource("dynamodb", region_name="us-east-1").Table("recon-cases").get_item(
        Key={"item_id": "idp-4"}
    )["Item"]
    assert row.get("proposed_email") is None
