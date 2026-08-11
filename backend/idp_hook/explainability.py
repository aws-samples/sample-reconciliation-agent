"""Aggregation of IDP's per-field extraction confidences into recon's classification signal.

IDP's Assessment step attaches a per-field confidence to each extracted value and reports it in
the section result's ``explainability_info``. It does NOT attach a confidence to
``document_class`` — verified across every live section result in recon-dev — so the composite's
0.45 classification slot has no source on the harness path and the harness has always scored on
the renormalized two-signal form. This module supplies that missing signal.

**Shape (verified against live IDP output).** ``explainability_info`` is a *list* of dicts; each
dict maps a field name to ``{"confidence": float, "confidence_threshold": float, "geometry": [...]}``.
Nested objects and arrays of objects recurse, so a table field's rows are scored individually.
Confidence thresholds are per-field (0.8 and 0.9 both occur live), never a single global constant.

**Only fields IDP actually extracted a value for are counted.** IDP scores an absent optional
field ``confidence: 0.0`` with an all-zero bounding box and a ``null`` value in
``inference_result``. Counting those collapses the aggregate to an artifact of how broad the
document schema is rather than how well the extraction went: across the 18 live sections that
carry ``explainability_info``, the all-fields mean spans 0.025-0.950 while the extracted-fields
mean spans 0.933-0.985 (median 0.956). See
the harness signal + tool-parity design record (D1).

Nothing here falls back to a fabricated value: a section with no ``explainability_info`` yields
``None``, and the composite keeps its existing ``None`` renormalization path (D3).
"""

from typing import Any, Optional

# Keys that mark a leaf confidence record inside explainability_info.
_CONFIDENCE_KEY = "confidence"
_THRESHOLD_KEY = "confidence_threshold"


def _is_empty(value: Any) -> bool:
    """Whether an ``inference_result`` value counts as "IDP extracted nothing here".

    :param value: the extracted value for one field (any JSON type, or None).
    :returns: True when the field is absent/blank and must be excluded from the aggregate.
    """
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def _walk(*, node: Any, values: Any, path: str) -> list[dict]:
    """Recursively pair every scored field in one ``explainability_info`` block with its value.

    Descends objects by key and arrays by index in lockstep with ``inference_result`` so each
    confidence record can be matched to the value it describes.

    :param node: the current explainability sub-tree (dict, list, or leaf).
    :param values: the corresponding ``inference_result`` sub-tree, or None when unpaired.
    :param path: dotted/bracketed field path accumulated so far, used for reporting.
    :returns: list of ``{field, confidence, threshold, value, extracted}`` records.
    """
    out: list[dict] = []
    if isinstance(node, dict):
        # A leaf confidence record: `confidence` present and scalar (a field literally named
        # "confidence" in the document schema would nest a dict here instead).
        conf = node.get(_CONFIDENCE_KEY)
        if isinstance(conf, (int, float)) and not isinstance(conf, bool):
            out.append(
                {
                    "field": path,
                    "confidence": float(conf),
                    "threshold": node.get(_THRESHOLD_KEY),
                    "value": values,
                    "extracted": not _is_empty(values),
                }
            )
            return out
        for key, child in node.items():
            child_values = values.get(key) if isinstance(values, dict) else None
            out.extend(
                _walk(node=child, values=child_values, path=f"{path}.{key}" if path else key)
            )
    elif isinstance(node, list):
        for index, child in enumerate(node):
            child_values = (
                values[index] if isinstance(values, list) and index < len(values) else None
            )
            out.extend(_walk(node=child, values=child_values, path=f"{path}[{index}]"))
    return out


def field_confidences(*, explainability_info: Any, inference_result: Any) -> list[dict]:
    """Flatten a section's ``explainability_info`` into per-field confidence records.

    :param explainability_info: the section result's ``explainability_info`` (a list of dicts in
        live IDP output; a bare dict is also accepted defensively since it costs nothing).
    :param inference_result: the section's extracted values, used to decide which fields IDP
        actually populated.
    :returns: list of ``{field, confidence, threshold, value, extracted}`` records; empty when
        there is no explainability data.
    """
    blocks = explainability_info if isinstance(explainability_info, list) else [explainability_info]
    records: list[dict] = []
    for block in blocks:
        if isinstance(block, (dict, list)):
            records.extend(_walk(node=block, values=inference_result, path=""))
    return records


def extraction_confidence(*, explainability_info: Any, inference_result: Any) -> Optional[float]:
    """Mean per-field confidence over the fields IDP actually extracted a value for.

    This is the value recon feeds into the composite's 0.45 classification slot on the harness
    path. Returns None — never a fabricated default — when the section carries no explainability
    data or extracted nothing, so the composite takes its existing renormalized path.

    :param explainability_info: the section result's ``explainability_info``.
    :param inference_result: the section's extracted values.
    :returns: mean confidence in [0, 1], or None when there is nothing to average.
    """
    extracted = [
        rec["confidence"]
        for rec in field_confidences(
            explainability_info=explainability_info, inference_result=inference_result
        )
        if rec["extracted"]
    ]
    if not extracted:
        return None
    return sum(extracted) / len(extracted)


def alert_count(*, explainability_info: Any, inference_result: Any) -> int:
    """Count extracted fields whose confidence is below THEIR OWN ``confidence_threshold``.

    Feeds the composite's 10% ``IDP_ALERT_PENALTY`` — the agent is reasoning over values IDP was
    itself unsure about. Thresholds are per-field (both 0.8 and 0.9 occur in live output), so this
    never compares against a global constant. Fields IDP extracted no value for are excluded: an
    absent optional field is not a data-quality alert (D1/D4).

    :param explainability_info: the section result's ``explainability_info``.
    :param inference_result: the section's extracted values.
    :returns: number of below-threshold extracted fields (0 when there is no explainability data).
    """
    count = 0
    for rec in field_confidences(
        explainability_info=explainability_info, inference_result=inference_result
    ):
        threshold = rec["threshold"]
        if rec["extracted"] and isinstance(threshold, (int, float)):
            if rec["confidence"] < float(threshold):
                count += 1
    return count
