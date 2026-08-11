"""Tests for the IDP-event → ReconItem mapper (PascalCase real shape + legacy fallback)."""

from decimal import Decimal

import pytest

from backend.idp_hook.mapper import idp_event_to_recon_item
from backend.recon_core.schema import ReconItem

# Real IDP completion/tracking shape (PascalCase), matching a live run.
PASCAL_DOC = {
    "ObjectKey": "Notice.pdf",
    "PageCount": 2,
    "WorkflowStatus": "SUCCEEDED",
    "ConfidenceAlertCount": 0,
    "Sections": [
        {
            "Id": "1",
            "Class": "LoanRateSettingNotice",
            "PageIds": [1],
            "OutputJSONUri": "s3://idp-out/Notice.pdf/sections/1/result.json",
        },
        {
            "Id": "2",
            "Class": "LoanPaymentNotice",
            "PageIds": [2],
            "OutputJSONUri": "s3://idp-out/Notice.pdf/sections/2/result.json",
        },
    ],
    "Pages": [
        {"Id": 1, "Class": "LoanRateSettingNotice", "ImageUri": "s3://idp-out/Notice.pdf/pages/1/image.jpg"},
        {"Id": 2, "Class": "LoanPaymentNotice", "ImageUri": "s3://idp-out/Notice.pdf/pages/2/image.jpg"},
    ],
}


class _FakeReader:
    """Stand-in IdpOutputReader returning canned section results + page images."""

    def __init__(self):
        self.calls = []

    def read(self, *, bucket, prefix):
        self.calls.append((bucket, prefix))
        return {
            "sections": [
                {
                    "section_id": "1",
                    "classification": "LoanRateSettingNotice",
                    "page_indices": [0],
                    "fields": {
                        "AgencyName": "Meridian Agency Services LLC",
                        "Date": "26-Dec-2026",
                        "GlobalAmount": 150800000.0,  # float -> must become Decimal
                    },
                    "output_uri": f"s3://{bucket}/{prefix}/sections/1/result.json",
                },
            ],
            "pages": [
                {"page_id": "1", "image_uri": f"s3://{bucket}/{prefix}/pages/1/image.jpg"},
            ],
        }


def test_pascalcase_event_derives_s3_location_and_backlinks():
    item = idp_event_to_recon_item(PASCAL_DOC, domain="cash")
    assert isinstance(item, ReconItem)
    assert item.item_id == "idp-Notice.pdf"
    assert item.domain == "cash"
    assert item.sides == []
    assert "idp:documentId=Notice.pdf" in item.source_refs
    assert item.attributes["idp_raw_ref"] == "s3://idp-out/Notice.pdf/"
    assert item.attributes["idp_page_count"] == 2
    assert item.attributes["idp_workflow_status"] == "SUCCEEDED"


def test_without_reader_falls_back_to_event_section_classes():
    # No output_reader -> classification/section list still captured from the event itself.
    item = idp_event_to_recon_item(PASCAL_DOC, domain="cash")
    secs = item.attributes["idp_sections"]
    assert [s["classification"] for s in secs] == ["LoanRateSettingNotice", "LoanPaymentNotice"]
    assert item.attributes["idp_class"] == "LoanRateSettingNotice"


def test_with_reader_embeds_extracted_field_values():
    reader = _FakeReader()
    item = idp_event_to_recon_item(PASCAL_DOC, domain="cash", output_reader=reader)
    # Reader was called with the derived bucket + document prefix.
    assert reader.calls == [("idp-out", "Notice.pdf")]
    sec = item.attributes["idp_sections"][0]
    assert sec["fields"]["AgencyName"] == "Meridian Agency Services LLC"
    assert item.attributes["idp_attributes"]["Date"] == "26-Dec-2026"
    # Page-image locations captured for the preview.
    assert item.attributes["idp_pages"][0]["image_uri"] == "s3://idp-out/Notice.pdf/pages/1/image.jpg"


def test_embedded_float_fields_become_decimal():
    item = idp_event_to_recon_item(PASCAL_DOC, domain="cash", output_reader=_FakeReader())
    amount = item.attributes["idp_sections"][0]["fields"]["GlobalAmount"]
    assert isinstance(amount, Decimal)  # would crash the real DynamoDB put if float


def test_missing_object_key_raises():
    with pytest.raises(ValueError):
        idp_event_to_recon_item({"Sections": []}, domain="cash")


def test_legacy_snakecase_shape_still_supported():
    legacy = {
        "id": "doc-42",
        "input_key": "notices/n1.pdf",
        "output_bucket": "idp-out",
        "sections": [
            {
                "section_id": "s0",
                "classification": "InterestNotice",
                "extraction_result_uri": "s3://idp-out/notices/n1.pdf/sections/s0/result.json",
                "attributes": {"total_amount": "1000.00", "borrower": "ACME"},
            }
        ],
    }
    item = idp_event_to_recon_item(legacy, domain="cash")
    assert item.item_id == "idp-doc-42"
    assert item.attributes["idp_class"] == "InterestNotice"
    assert item.attributes["idp_sections"][0]["fields"] == {
        "total_amount": "1000.00",
        "borrower": "ACME",
    }
