"""Classify a reconciliation item against the SKILL.md catalog.

The catalog (from skills_loader.catalog) IS the classification-type registry — there is no
DynamoDB lookup. If the model's confidence is below the global classification threshold
(``skills_loader.DEFAULT_CLASS_THRESHOLD``), fall back to the 'unknown' type while preserving
the model's reasoning for the UI.
"""

from backend.recon_core.schema import ClassificationResult
from skills_loader import DEFAULT_CLASS_THRESHOLD


def pick_class(*, catalog: list[dict], fake_llm) -> ClassificationResult:
    """Ask the model to pick a classification type from the SKILL.md catalog.

    ``fake_llm`` is a callable taking the catalog and returning
    ``(class_name, confidence, reasoning)``. It is injected for tests; production passes a
    Strands-model-backed callable that sees the catalog. If confidence is below the global
    ``DEFAULT_CLASS_THRESHOLD`` (or the name isn't a known type), it falls back to 'unknown'
    but keeps the reasoning.
    """
    name, conf, reasoning = fake_llm(catalog)
    known = {c["name"] for c in catalog}
    if name in known and conf >= DEFAULT_CLASS_THRESHOLD:
        return ClassificationResult(class_id=name, confidence=conf, reasoning=reasoning)
    return ClassificationResult(class_id="unknown", confidence=conf, reasoning=reasoning)
