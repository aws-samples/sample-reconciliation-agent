"""Classify a reconciliation item against the SKILL.md catalog.

The catalog (from skills_loader.catalog) IS the classification-type registry — there is no DynamoDB
lookup. The model picks from the catalog; a pick that is not IN the catalog falls back to 'unknown'
while preserving the model's reasoning for the UI.

There is deliberately NO confidence floor here, and the model is never asked how sure it is. Rewriting
a low-confidence pick to 'unknown' would make a self-reported number an unappealable gate: 'unknown'
declares no evidence_steps, so the case scores 0.0 and cannot auto-resolve however complete its
evidence is — one uncertain answer about the class discards the whole investigation. Escalation is
decided downstream instead, by the computed evidence-completeness score against the skill's threshold.

Classification still matters: it names the ONE skill whose prescribed required steps form the scoring
denominator (``recon_core.confidence.score_proposal``). It does not restrict which skills the agent
may use — both backends load the whole library.

Tier-1's ``tier1_break_type`` does NOT short-circuit this. It is a hint carried on the investigation
prompt (``strands_investigator._class_hint_block``), never a decision: the classification recorded on
the case is always the agent's own. Tier-1 classifies with a plain-Python rule table that cannot see
the catalog, so letting it decide would pin the case to a vocabulary the catalog is free to change,
and the agent's reasoning would then explain a type it did not pick. A disagreement with the hint is
LOGGED and nothing more — see ``recon_core.tier1_hint.warn_on_disagreement``.
"""

from backend.recon_core.schema import ClassificationResult
from backend.recon_core.tier1_hint import warn_on_disagreement


def pick_class(
    *, catalog: list[dict], fake_llm, tier1_hint: str | None = None
) -> ClassificationResult:
    """Pick a classification type from the catalog by model label.

    ``fake_llm`` is a callable taking the catalog and returning ``(class_name, reasoning)``. It is
    injected for tests; production passes a Strands-model-backed callable that sees the catalog.

    :param catalog: the SKILL.md catalog (the classification-type registry).
    :param fake_llm: the model-backed picker.
    :param tier1_hint: Tier-1's rule-table guess (``recon_core.tier1_hint.read_hint``), or None.
        **Advisory and never overruling** — it is compared to the result purely so a disagreement is
        logged. Defaulted to None so a caller with no item attributes to hand stays correct.
    :returns: the classification — the model's pick when it names a catalog entry, else 'unknown'
        with the model's reasoning preserved.
    """
    known = {c["name"] for c in catalog}
    name, reasoning = fake_llm(catalog)
    class_id = name if name in known else "unknown"
    warn_on_disagreement(class_id=class_id, tier1_hint=tier1_hint)
    return ClassificationResult(class_id=class_id, reasoning=reasoning)
