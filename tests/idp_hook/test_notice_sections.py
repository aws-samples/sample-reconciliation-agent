"""Per-section extraction detail embedded on the notice row at ingest.

The Documents drawer renders what the extractor read from the notice row itself. It used to ask
IDP's GraphQL API for the same section results on every open, which needed a second field-scoped
grant on somebody else's AppSync API and a TypeScript re-implementation of
``backend/idp_hook/explainability.py``. Embedding at ingest removes both, on the same grounds as
``idp_pages``: the values are already in hand when the hook runs.

Two things must hold for that to be safe, and they are what this module pins:

* the per-field records the reader keeps are the SAME records both aggregates were reduced from, so
  a row's stored detail can never contradict its own ``extraction_confidence``;
* the per-section ``mean_confidence``/``alert_count`` carried inside ``idp_sections`` are NOT the
  notice-level ``extraction_confidence``/``confidence_alert_count``. Those two are the first
  section's score and the sum across sections, and the interceptor reads the notice-level ones.
"""

import json
from decimal import Decimal

import boto3
from moto import mock_aws

from backend.idp_hook.idp_output import IdpOutputReader
from backend.idp_hook.mapper import idp_event_to_notice

BUCKET = "idp-out"
PREFIX = "Notice.pdf"


def _seed_section() -> None:
    """Seed one section result carrying explainability for two extracted fields and one absent one.

    :returns: None.
    """
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=BUCKET)
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{PREFIX}/sections/1/result.json",
        Body=json.dumps(
            {
                "document_class": {"type": "LoanPaymentNotice"},
                "split_document": {"page_indices": [0]},
                "inference_result": {
                    "BorrowerName": "NORTHWIND MIDCO",
                    # Below its own 0.9 threshold, and extracted -> the one alert.
                    "Amount": "10",
                    "Fax": None,
                },
                "explainability_info": [
                    {
                        "BorrowerName": {"confidence": 1.0, "confidence_threshold": 0.8},
                        "Amount": {"confidence": 0.8, "confidence_threshold": 0.9},
                        "Fax": {"confidence": 0.0, "confidence_threshold": 0.8},
                    }
                ],
            }
        ),
    )


@mock_aws
def test_the_reader_keeps_the_per_field_records_it_reduced() -> None:
    """The records are on the section, not thrown away after the aggregates were computed.

    :returns: None.
    """
    _seed_section()
    section = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"][0]
    records = {rec["field"]: rec for rec in section["field_confidences"]}
    assert set(records) == {"BorrowerName", "Amount", "Fax"}
    assert records["BorrowerName"]["value"] == "NORTHWIND MIDCO"
    assert records["BorrowerName"]["extracted"] is True
    # The absent optional field is still recorded — the drawer shows it as read-but-empty rather
    # than omitting it, which is why it is kept despite being excluded from both aggregates.
    assert records["Fax"]["extracted"] is False


@mock_aws
def test_the_kept_records_are_decimal_safe() -> None:
    """boto3's DynamoDB resource rejects floats, and these records go onto the stored row.

    :returns: None.
    """
    _seed_section()
    section = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"][0]
    assert isinstance(section["field_confidences"][0]["confidence"], Decimal)


@mock_aws
def test_the_aggregates_still_reduce_the_kept_records() -> None:
    """Both aggregates are unchanged by keeping the records — they now reduce them in place.

    :returns: None.
    """
    _seed_section()
    section = IdpOutputReader().read(bucket=BUCKET, prefix=PREFIX)["sections"][0]
    # Mean of the two EXTRACTED fields (1.0, 0.8); Fax's 0.0 excluded.
    assert section["classification_confidence"] == Decimal(str(0.9))
    # Amount's 0.8 breaches its OWN 0.9 threshold; Fax's 0.0 does not count, having no value.
    assert section["confidence_alert_count"] == 1


class _FakeReader:
    """Reader returning two sections, each with its own field records and its own aggregates."""

    def read(self, *, bucket: str, prefix: str) -> dict:
        """Return two enriched sections and no pages.

        :param bucket: IDP output bucket the mapper derived.
        :param prefix: document prefix within that bucket.
        :returns: the reader's ``{"sections": [...], "pages": [...]}`` shape.
        """

        def section(*, sid: str, conf: float, alerts: int) -> dict:
            return {
                "section_id": sid,
                "classification": f"Class{sid}",
                "page_indices": [int(sid) - 1],
                # Only the first section's fields build the notice, but every section needs a
                # notice_date for this fixture to stay valid if that preference ever changes.
                "fields": {"counterparty": "NORTHWIND MIDCO", "notice_date": "2026-04-01"},
                "output_uri": f"s3://{bucket}/{prefix}/sections/{sid}/result.json",
                "field_confidences": [
                    {
                        "field": "counterparty",
                        "confidence": conf,
                        "threshold": 0.8,
                        "value": "NORTHWIND MIDCO",
                        "extracted": True,
                    }
                ],
                "classification_confidence": conf,
                "confidence_alert_count": alerts,
            }

        return {
            "sections": [
                section(sid="1", conf=0.95, alerts=1),
                section(sid="2", conf=0.80, alerts=2),
            ],
            "pages": [],
        }


def _event() -> dict:
    """Build the completion event whose section URI points the mapper at the reader.

    :returns: an IDP completion record carrying one section OutputJSONUri.
    """
    return {
        "ObjectKey": "Notice.pdf",
        "Sections": [
            {"Id": "1", "OutputJSONUri": f"s3://{BUCKET}/{PREFIX}/sections/1/result.json"}
        ],
    }


def test_every_section_reaches_the_notice_with_its_fields_and_confidences() -> None:
    """One entry per section, carrying what the drawer renders without any call back into IDP.

    :returns: None.
    """
    notice = idp_event_to_notice(_event(), output_reader=_FakeReader(), execution_arn="arn:x")
    assert [s["section_id"] for s in notice.idp_sections] == ["1", "2"]
    first = notice.idp_sections[0]
    assert first["classification"] == "Class1"
    assert first["page_ids"] == [0]
    assert first["fields"]["counterparty"] == "NORTHWIND MIDCO"
    assert first["confidences"][0]["field"] == "counterparty"


def test_the_per_section_aggregates_are_not_the_notice_level_ones() -> None:
    """Confusing the two would make the interceptor's guard read a single section's count.

    :returns: None.
    """
    notice = idp_event_to_notice(_event(), output_reader=_FakeReader(), execution_arn="arn:x")
    assert [s["alert_count"] for s in notice.idp_sections] == [1, 2]
    assert notice.confidence_alert_count == 3  # the SUM across sections
    assert [s["mean_confidence"] for s in notice.idp_sections] == [
        Decimal(str(0.95)),
        Decimal(str(0.80)),
    ]
    assert notice.extraction_confidence == Decimal(str(0.95))  # the FIRST section's


def test_section_floats_become_decimal() -> None:
    """The whole block is stored, so a float anywhere in it would break every live put.

    :returns: None.
    """
    notice = idp_event_to_notice(_event(), output_reader=_FakeReader(), execution_arn="arn:x")
    assert isinstance(notice.idp_sections[0]["confidences"][0]["confidence"], Decimal)


def test_a_section_with_no_explainability_still_reaches_the_notice() -> None:
    """17 of 35 live section results carry no explainability at all — that is not a missing section.

    Empty ``confidences`` is a real answer the drawer distinguishes from "no notice row".

    :returns: None.
    """
    notice = idp_event_to_notice(
        {
            "ObjectKey": "Notice.pdf",
            "Sections": [{"Id": "1", "Class": "A", "attributes": {"notice_date": "2026-04-01"}}],
        },
        output_reader=None,
        execution_arn="arn:x",
    )
    assert len(notice.idp_sections) == 1
    assert notice.idp_sections[0]["confidences"] == []
    assert notice.idp_sections[0]["mean_confidence"] is None
