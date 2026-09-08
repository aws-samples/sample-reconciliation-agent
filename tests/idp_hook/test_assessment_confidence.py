"""IDP Assessment classification confidence capture.

The reader resolves each section's classification confidence and the mapper stores the first
section's as the notice's ``extraction_confidence`` — None when nothing is available, so
pre-Assessment documents degrade gracefully onto the composite's renormalized path.

Two sources, in preference order:

1. ``document_class.confidence``. Kept for forward compatibility only — IDP does **not** emit it
   in any live recon-dev output (every ``document_class`` is bare ``{"type": ...}``), which is why
   the harness's classification slot was ``None`` on every item.
2. the mean per-field extraction confidence from ``explainability_info``, over the fields IDP
   actually extracted a value for. This is the source that fires in practice.
"""

import json
from decimal import Decimal

import boto3
from moto import mock_aws

from backend.idp_hook.idp_output import IdpOutputReader
from backend.idp_hook.mapper import idp_event_to_notice

BUCKET = "idp-out"
PREFIX = "Notice.pdf"


def _seed(*, with_confidence: bool):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=BUCKET)
    doc_class = {"type": "LoanDrawCancellationNotice"}
    if with_confidence:
        doc_class["confidence"] = 0.976
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{PREFIX}/sections/1/result.json",
        Body=json.dumps(
            {
                "document_class": doc_class,
                "split_document": {"page_indices": [0]},
                "inference_result": {"BorrowerName": "NORTHWIND MIDCO"},
            }
        ),
    )


@mock_aws
def test_reader_surfaces_classification_confidence_when_present():
    _seed(with_confidence=True)
    secs = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"]
    assert secs[0]["classification"] == "LoanDrawCancellationNotice"
    assert secs[0]["classification_confidence"] == Decimal(str(0.976))


@mock_aws
def test_reader_omits_confidence_when_absent():
    _seed(with_confidence=False)
    secs = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"]
    assert secs[0].get("classification_confidence") is None


class _FakeReader:
    """Reader returning one section, optionally carrying a classification confidence."""

    def __init__(self, *, with_confidence: bool):
        self._conf = with_confidence

    def read(self, *, bucket, prefix):
        sec = {
            "section_id": "1",
            "classification": "LoanDrawCancellationNotice",
            "page_indices": [0],
            # notice_date is required: it is the counterparty-index range key, and the mapper raises
            # without one rather than store a row the agent's main query can never return.
            "fields": {"counterparty": "NORTHWIND MIDCO", "notice_date": "2026-04-01"},
            "output_uri": f"s3://{bucket}/{prefix}/sections/1/result.json",
        }
        if self._conf:
            sec["classification_confidence"] = 0.976
        return {"sections": [sec], "pages": []}


def _event() -> dict:
    """Build the minimal completion event that points the mapper at the seeded section.

    :returns: an IDP completion record carrying one section OutputJSONUri.
    """
    return {
        "ObjectKey": "Notice.pdf",
        "Sections": [
            {"Id": "1", "OutputJSONUri": f"s3://{BUCKET}/{PREFIX}/sections/1/result.json"}
        ],
    }


def test_mapper_stores_idp_classification_confidence():
    notice = idp_event_to_notice(_event(), output_reader=_FakeReader(with_confidence=True))
    assert notice.notice_class == "LoanDrawCancellationNotice"
    assert notice.extraction_confidence == Decimal(str(0.976))


def test_mapper_omits_confidence_when_absent():
    notice = idp_event_to_notice(_event(), output_reader=_FakeReader(with_confidence=False))
    # None, not 0.0: "unknown confidence" and "zero confidence" score differently downstream.
    assert notice.extraction_confidence is None


# ---------------------------------------------------------------------------------
# Source 2: derived from explainability_info (the path that actually fires live).
# ---------------------------------------------------------------------------------


def _seed_explainability(*, doc_class_confidence: float | None = None):
    """Seed one section with explainability_info: two extracted fields + one absent field."""
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=BUCKET)
    doc_class = {"type": "LoanDrawCancellationNotice"}
    if doc_class_confidence is not None:
        doc_class["confidence"] = doc_class_confidence
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{PREFIX}/sections/1/result.json",
        Body=json.dumps(
            {
                "document_class": doc_class,
                "split_document": {"page_indices": [0]},
                "inference_result": {
                    "BorrowerName": "NORTHWIND MIDCO",
                    "Amount": "10",
                    "Fax": None,
                },
                "explainability_info": [
                    {
                        "BorrowerName": {"confidence": 1.0, "confidence_threshold": 0.8},
                        "Amount": {"confidence": 0.9, "confidence_threshold": 0.8},
                        # Absent optional field — excluded from the mean AND from the alert count.
                        "Fax": {"confidence": 0.0, "confidence_threshold": 0.8},
                    }
                ],
            }
        ),
    )


@mock_aws
def test_reader_derives_confidence_from_explainability_when_document_class_has_none():
    _seed_explainability()
    secs = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"]
    # Mean of the two EXTRACTED fields (1.0, 0.9) — Fax's 0.0 is excluded.
    assert secs[0]["classification_confidence"] == Decimal(str(0.95))


@mock_aws
def test_document_class_confidence_wins_over_the_derived_value():
    """Preference order matters: an explicit IDP class confidence is the better signal."""
    _seed_explainability(doc_class_confidence=0.5)
    secs = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"]
    assert secs[0]["classification_confidence"] == Decimal(str(0.5))


@mock_aws
def test_reader_always_emits_an_alert_count():
    """0 is meaningful ("checked, nothing flagged") — unlike the NULL this replaces."""
    _seed_explainability()
    secs = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"]
    assert secs[0]["confidence_alert_count"] == 0


class _FakeMultiSectionReader:
    """Reader returning two sections, each carrying its own alert count."""

    def read(self, *, bucket, prefix):
        def sec(sid: str, conf: float, alerts: int) -> dict:
            return {
                "section_id": sid,
                "classification": f"Class{sid}",
                # Only the FIRST section's fields are read, but every section needs a date for the
                # test to stay valid if the mapper's section preference ever changes.
                "fields": {"counterparty": "NORTHWIND MIDCO", "notice_date": "2026-04-01"},
                "output_uri": "",
                "classification_confidence": conf,
                "confidence_alert_count": alerts,
            }

        return {"sections": [sec("1", 0.95, 1), sec("2", 0.80, 2)], "pages": []}


def test_mapper_sums_alert_counts_across_all_sections():
    """The agent may reason over any section, so the penalty reflects the whole document.

    Also asserts the event's ConfidenceAlertCount is IGNORED once section data is available — it
    is NULL on every live item, which is what left the 10% penalty permanently inert.
    """
    # A section OutputJSONUri is what tells the mapper where to read from, so the reader runs.
    doc = {
        "ObjectKey": "Notice.pdf",
        "ConfidenceAlertCount": None,
        "Sections": [
            {"Id": "1", "OutputJSONUri": f"s3://{BUCKET}/{PREFIX}/sections/1/result.json"}
        ],
    }
    notice = idp_event_to_notice(doc, output_reader=_FakeMultiSectionReader())
    assert notice.confidence_alert_count == 3
    # First section's confidence is the one stored.
    assert notice.extraction_confidence == Decimal(str(0.95))


def test_mapper_falls_back_to_the_event_alert_count_when_no_sections_were_read():
    """Event-only path (output read failed / no reader): keep whatever the event carried."""
    doc = {
        "ObjectKey": "Notice.pdf",
        "ConfidenceAlertCount": 4,
        "Sections": [
            {"Id": "1", "Class": "A", "attributes": {"notice_date": "2026-04-01"}},
        ],
    }
    notice = idp_event_to_notice(doc, output_reader=None)
    assert notice.confidence_alert_count == 4
