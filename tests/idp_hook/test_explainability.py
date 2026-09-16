"""Aggregation of IDP per-field confidences into the composite's classification signal.

The fixture mirrors the real shape verified against
``s3://<idp-output-bucket>/*/sections/*/result.json``: ``explainability_info`` is a LIST of
dicts, each field maps to ``{confidence, confidence_threshold, geometry}``, nested arrays of
objects are scored per row, and per-field thresholds differ (0.8 and 0.9 both occur live).
"""

import pytest

from backend.idp_hook.explainability import (
    alert_count,
    below_threshold_count,
    extraction_confidence,
    field_confidences,
    mean_confidence,
)


def _geom() -> list[dict]:
    """Return a throwaway geometry block (present on every live record, never read)."""
    return [{"boundingBox": {"top": 0.1, "left": 0.1, "width": 0.2, "height": 0.02}, "page": 1}]


# Live-shaped section result: two clean fields, one absent optional field IDP scored 0.0, and a
# two-row table whose second row has a genuinely low-confidence EXTRACTED value.
EXPLAINABILITY = [
    {
        "BorrowerName": {"confidence": 1.0, "confidence_threshold": 0.8, "geometry": _geom()},
        "Date": {"confidence": 0.9, "confidence_threshold": 0.8, "geometry": _geom()},
        # Absent optional field: IDP scores 0.0 with an all-zero box and leaves the value null.
        "Fax": {"confidence": 0.0, "confidence_threshold": 0.8, "geometry": _geom()},
        "AccrualLineItems": [
            {"Amount": {"confidence": 0.95, "confidence_threshold": 0.9, "geometry": _geom()}},
            {"Amount": {"confidence": 0.5, "confidence_threshold": 0.9, "geometry": _geom()}},
        ],
    }
]

INFERENCE = {
    "BorrowerName": "Cascade Holdings LLC",
    "Date": "2026-08-01",
    "Fax": None,
    "AccrualLineItems": [{"Amount": "1,250,000.00"}, {"Amount": "42.00"}],
}


def test_flattens_nested_arrays_and_pairs_each_field_with_its_value():
    recs = {
        r["field"]: r
        for r in field_confidences(explainability_info=EXPLAINABILITY, inference_result=INFERENCE)
    }
    assert set(recs) == {
        "BorrowerName",
        "Date",
        "Fax",
        "AccrualLineItems[0].Amount",
        "AccrualLineItems[1].Amount",
    }
    # Array rows are paired positionally with inference_result, not merged.
    assert recs["AccrualLineItems[0].Amount"]["value"] == "1,250,000.00"
    assert recs["AccrualLineItems[1].Amount"]["value"] == "42.00"
    # The null-valued field is scored but marked unextracted.
    assert recs["Fax"]["extracted"] is False
    assert recs["BorrowerName"]["extracted"] is True


def test_extraction_confidence_excludes_fields_idp_extracted_nothing_for():
    """The load-bearing rule: absent optional fields must not drag the aggregate down.

    Including Fax's 0.0 would give 0.67; excluding it gives the mean of the four real
    extractions. Across the live corpus this is the difference between a 0.025-0.950 noise band
    and a 0.933-0.985 signal.
    """
    got = extraction_confidence(explainability_info=EXPLAINABILITY, inference_result=INFERENCE)
    assert got == pytest.approx(0.8375)  # mean of the four extracted fields
    all_fields_mean = 0.67  # (1.0 + 0.9 + 0.0 + 0.95 + 0.5) / 5 — what NOT to compute
    assert got > all_fields_mean


def test_alert_fires_only_for_a_below_threshold_field_that_was_extracted():
    """Per-field thresholds, and Fax (0.0 < 0.8) must NOT count — it has no value."""
    assert alert_count(explainability_info=EXPLAINABILITY, inference_result=INFERENCE) == 1


def test_alert_count_uses_each_fields_own_threshold_not_a_global_constant():
    # 0.85 clears an 0.8 threshold but breaches a 0.9 one; a global constant would score both alike.
    info = [
        {
            "A": {"confidence": 0.85, "confidence_threshold": 0.8},
            "B": {"confidence": 0.85, "confidence_threshold": 0.9},
        }
    ]
    values = {"A": "x", "B": "y"}
    assert alert_count(explainability_info=info, inference_result=values) == 1


def test_missing_explainability_yields_none_not_a_fabricated_default():
    """Fail loudly, never silently default: pre-Assessment documents keep the renormalized path.

    17 of the 35 live section results carry no explainability_info at all, so this is the common
    case, not an edge case — and it must NOT become a 0.0 that tanks the composite, nor a 1.0
    that inflates it.
    """
    assert extraction_confidence(explainability_info=None, inference_result={}) is None
    assert extraction_confidence(explainability_info=[], inference_result={}) is None
    assert alert_count(explainability_info=None, inference_result={}) == 0


def test_all_fields_absent_yields_none_rather_than_zero():
    info = [{"Fax": {"confidence": 0.0, "confidence_threshold": 0.8}}]
    assert extraction_confidence(explainability_info=info, inference_result={"Fax": None}) is None


def test_empty_strings_and_empty_collections_count_as_not_extracted():
    info = [
        {
            "Blank": {"confidence": 0.1, "confidence_threshold": 0.8},
            "EmptyList": {"confidence": 0.1, "confidence_threshold": 0.8},
            "Real": {"confidence": 1.0, "confidence_threshold": 0.8},
        }
    ]
    values = {"Blank": "   ", "EmptyList": [], "Real": "v"}
    assert extraction_confidence(explainability_info=info, inference_result=values) == 1.0
    assert alert_count(explainability_info=info, inference_result=values) == 0


def test_zero_is_a_valid_extracted_value_and_is_not_treated_as_absent():
    """A numeric 0 / False is real extracted data — only None/blank/empty-collection is absent."""
    info = [{"Amount": {"confidence": 0.4, "confidence_threshold": 0.8}}]
    assert extraction_confidence(explainability_info=info, inference_result={"Amount": 0}) == 0.4
    assert alert_count(explainability_info=info, inference_result={"Amount": 0}) == 1


def test_the_record_reductions_agree_with_the_walk_and_reduce_helpers():
    """Reducing kept records must give exactly what walking again gives.

    The caller that persists the records (``idp_output._read_sections``) reduces them directly
    instead of re-walking. If the two paths could disagree, a notice's stored per-field detail would
    contradict its own ``extraction_confidence`` — the number the interceptor and the prompt read.
    """
    records = field_confidences(explainability_info=EXPLAINABILITY, inference_result=INFERENCE)
    assert mean_confidence(records) == extraction_confidence(
        explainability_info=EXPLAINABILITY, inference_result=INFERENCE
    )
    assert below_threshold_count(records) == alert_count(
        explainability_info=EXPLAINABILITY, inference_result=INFERENCE
    )
    # Pinned to the literal values so a change to either path is visible here, not just consistent.
    assert mean_confidence(records) == pytest.approx(0.8375)
    assert below_threshold_count(records) == 1


def test_reducing_no_records_yields_none_and_zero_rather_than_a_default():
    """The empty case has to behave like the walk-and-reduce one: absence stays absence."""
    assert mean_confidence([]) is None
    assert below_threshold_count([]) == 0


def test_a_field_literally_named_confidence_is_not_mistaken_for_a_leaf_record():
    """Guards the leaf test: `confidence` is a leaf only when its value is a scalar number."""
    info = [{"Nested": {"confidence": {"confidence": 0.7, "confidence_threshold": 0.8}}}]
    recs = field_confidences(
        explainability_info=info, inference_result={"Nested": {"confidence": "v"}}
    )
    assert [r["field"] for r in recs] == ["Nested.confidence"]
    assert recs[0]["confidence"] == 0.7
