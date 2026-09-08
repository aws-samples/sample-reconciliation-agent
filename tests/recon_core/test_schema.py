"""Tests for the shared ReconItem/ReconSide domain schema."""

import pytest
from pydantic import ValidationError

from backend.recon_core.schema import (
    EvidenceStep,
    ReasoningStep,
    ReconItem,
    ReconSide,
    SkillResultSpec,
)


def test_recon_item_requires_two_sides_and_domain():
    """A ReconItem carries a domain, its sides, source refs, and defaults to tier 1."""
    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "100.00"}),
            ReconSide(name="ledger", attributes={"amount": "100.00"}),
        ],
        source_refs=["s3://raw/i-1"],
    )
    assert item.domain == "cash"
    assert len(item.sides) == 2
    assert item.tier == 1  # defaults to tier 1 on creation


def test_recon_item_carries_top_level_attributes():
    """The IDP hook stores idp_class / idp_attributes in a free-form top-level bag."""
    item = ReconItem(
        item_id="idp-x",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
        attributes={"idp_class": "InterestNotice"},
    )
    assert item.attributes["idp_class"] == "InterestNotice"
    assert ReconItem(item_id="y", domain="cash", sides=[]).attributes == {}


# --- skill front-matter declarations ---------------------------------------------------------------


def test_evidence_step_requires_id_and_defaults_required_true() -> None:
    """A step declared with only an id and description counts toward the required denominator."""
    step = EvidenceStep(id="fund_alias_match", description="Resolve the fund label.")
    assert step.required is True


def test_evidence_step_rejects_non_bool_required() -> None:
    """A hand-typed non-boolean must fail loudly rather than coerce to a silent default."""
    with pytest.raises(ValidationError):
        EvidenceStep(id="x", description="d", required="yes-please")


def test_result_spec_rejects_unknown_cardinality() -> None:
    """Only the two declared cardinalities exist; anything else is a typo, not a new mode."""
    with pytest.raises(ValidationError):
        SkillResultSpec(cardinality="a_few", max_candidates=5)


def test_result_spec_ranked_set_requires_positive_max() -> None:
    """A ranked set of zero candidates is not a ranking — reject it at parse time."""
    with pytest.raises(ValidationError):
        SkillResultSpec(cardinality="ranked_set", max_candidates=0)


# --- evidence-completeness fields on the trace step ----------------------------------------------


def test_reasoning_step_defaults_keep_old_traces_valid() -> None:
    """Every persisted case predates these fields; an old step must still validate."""
    # If an old step stopped validating, the case-detail view would 500 on historical cases
    # rather than degrade.
    step = ReasoningStep(skill="propose", reasoning="x")
    assert step.step_id is None
    assert step.satisfied is None


def test_unattempted_is_distinguishable_from_attempted_and_empty() -> None:
    """None = never attempted; False = attempted, came back empty."""
    # Both score as unsatisfied, but the UI and the eval set need to tell them apart.
    attempted = ReasoningStep(skill="s", reasoning="r", satisfied=False)
    assert attempted.satisfied is False
    assert ReasoningStep(skill="s", reasoning="r").satisfied is None


def test_evidence_step_is_a_trace_kind() -> None:
    """The scorer reads these entries by kind, so the discriminator has to admit them."""
    step = ReasoningStep(
        skill="s",
        reasoning="r",
        kind="evidence_step",
        step_id="ledger_hit",
        satisfied=True,
    )
    assert (step.kind, step.step_id, step.satisfied) == ("evidence_step", "ledger_hit", True)
