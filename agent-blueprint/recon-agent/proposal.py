"""Build a propose-only Proposal from a classification and an investigation run."""

from collections.abc import Callable

from backend.recon_core.schema import (
    ClassificationResult,
    InvestigationResult,
    Proposal,
    ReconItem,
)


def build_proposal(
    *,
    item: ReconItem,
    classification: ClassificationResult,
    fake_investigate: Callable[[ReconItem, list[dict]], InvestigationResult],
    skills: list[dict],
) -> Proposal:
    """Run the investigation (skills loop) and package a propose-only result.

    ``fake_investigate`` is ``callable(item, skills) -> InvestigationResult``. One shape, not three
    arities: a fake returning anything else fails loudly at attribute access instead of quietly
    binding the wrong values.

    ``Proposal.confidence`` is deliberately left at its 0.0 default here. It is written by
    ``agent.score_by_evidence`` from the trace once the skills are known, and 0.0 until then is the
    fail-safe value — an unscored proposal is below every threshold and escalates.

    :param item: the reconciliation item under investigation.
    :param classification: the agent's own classification of the item.
    :param fake_investigate: the investigation callable, injected so tests can supply a fake.
    :param skills: the loaded SKILL.md dicts handed to the investigation.
    :returns: the propose-only Proposal, unscored.
    """
    result = fake_investigate(item, skills)
    return Proposal(
        item_id=item.item_id,
        class_id=classification.class_id,
        classification_reasoning=classification.reasoning,
        resolution=result.resolution,
        steps=result.steps,
        proposed_action=result.proposed_action,
        proposed_email=result.proposed_email,
        # Passed through rather than re-derived: the investigator is the only place that saw the
        # `search_notices` results, and this backend's persist path writes what lands here.
        notice_search=result.notice_search,
    )
