"""Build a propose-only Proposal from a classification and an investigation run."""

from backend.recon_core.schema import ClassificationResult, Proposal, ReconItem


def build_proposal(*, item: ReconItem, classification: ClassificationResult, fake_investigate, skills):
    """Run the investigation (skills loop) and package a propose-only result.

    Carries the classification reasoning/confidence and the typed trace steps.
    ``fake_investigate`` is a callable returning one of three arities, longest first:

    * ``(resolution, confidence, [ReasoningStep], proposed_action, proposed_email)`` — current
    * ``(resolution, confidence, [ReasoningStep], proposed_action)``
    * ``(resolution, confidence, [ReasoningStep])`` — legacy

    All three are accepted so existing injected fakes keep working. **Three arities is a smell**:
    dispatching on tuple length means a fake that returns the wrong number of values is a silently
    different contract rather than an error. The right fix is a typed result object, deliberately
    deferred because it touches every injected fake in the suite and would bury the change that
    added the draft. Do not add a fourth arity — do the refactor instead.
    """
    result = fake_investigate(item, skills)
    proposed_action = proposed_email = None
    if len(result) == 5:
        resolution, confidence, steps, proposed_action, proposed_email = result
    elif len(result) == 4:
        resolution, confidence, steps, proposed_action = result
    else:
        resolution, confidence, steps = result
    return Proposal(
        item_id=item.item_id,
        class_id=classification.class_id,
        classification_confidence=classification.confidence,
        classification_reasoning=classification.reasoning,
        resolution=resolution,
        confidence=confidence,
        steps=steps,
        proposed_action=proposed_action,
        proposed_email=proposed_email,
    )
