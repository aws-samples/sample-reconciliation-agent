"""Tests for the IDP-event -> Notice mapper.

The fixtures use the PascalCase shape of a real IDP completion record, not an invented one: getting
that wrong once already cost a silent field-drop (see backend/idp_hook/mapper.py's module docstring).
"""

from decimal import Decimal

import pytest

from backend.idp_hook.mapper import idp_event_to_notice


def _document(**overrides: object) -> dict:
    """Build a minimal PascalCase IDP completion record.

    The section carries ``attributes`` because that is what the event-only path (no output reader)
    reads its extracted field values from.

    :param overrides: keys to replace in the baseline record.
    :returns: the record as IDP emits it.
    """
    doc: dict = {
        "ObjectKey": "Paydown_and_Interest_Notice.pdf",
        "PageCount": 3,
        "WorkflowStatus": "SUCCEEDED",
        # NULL on every live document — see the note in idp_event_to_recon_item.
        "ConfidenceAlertCount": None,
        "Sections": [
            {
                "Id": "1",
                "Class": "LoanRateSettingNotice",
                "PageIds": [1],
                "OutputJSONUri": "s3://idp-out/Notice.pdf/sections/1/result.json",
                "attributes": {
                    "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
                    "notice_date": "2026-03-02",
                    "reference": "WIRE-20260302-EVG",
                    "amount": "9640.18",
                },
            }
        ],
    }
    doc.update(overrides)
    return doc


def test_notice_id_is_derived_from_the_object_key() -> None:
    """The id must be deterministic so a re-delivered event overwrites rather than duplicates."""
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    assert notice.notice_id == "idp-Paydown_and_Interest_Notice.pdf"
    assert notice.idp_execution_arn == "arn:x"


def test_notice_class_comes_from_the_first_section() -> None:
    """Recon never branches on the class, but it is what makes a field legitimately absent."""
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    assert notice.notice_class == "LoanRateSettingNotice"


def test_unresolvable_alert_count_maps_to_none_not_zero() -> None:
    """None => the interceptor refuses the write. Zero would silently permit it."""
    # The event-only path cannot resolve per-section counts, and IDP's own field is NULL.
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    assert notice.confidence_alert_count is None


def test_a_field_this_class_never_extracted_is_none_not_empty() -> None:
    """None and "" mean different things downstream: unavailable vs extracted-and-blank."""
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    # The fixture's class extracts no fund or facility at all.
    assert notice.fund is None
    assert notice.facility is None
    # ...but it did extract a reference and an amount.
    assert notice.reference == "WIRE-20260302-EVG"
    assert notice.amount == Decimal("9640.18")


def test_amount_is_a_decimal_not_a_float() -> None:
    """boto3's DynamoDB resource raises TypeError on float, so a float would fail every live put."""
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    assert isinstance(notice.amount, Decimal)


def test_an_unparseable_amount_raises() -> None:
    """A silently dropped amount makes an unmatchable notice look merely unmatched."""
    doc = _document()
    doc["Sections"][0]["attributes"]["amount"] = "n/a"
    with pytest.raises(ValueError, match="amount"):
        idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")


def test_missing_object_key_raises() -> None:
    """Without an ObjectKey there is no deterministic id, so re-delivery would duplicate."""
    with pytest.raises(ValueError, match="ObjectKey"):
        idp_event_to_notice({"PageCount": 1}, output_reader=None, execution_arn="arn:x")


def test_a_document_with_no_extractable_date_raises() -> None:
    """notice_date is the counterparty-index range key: a dateless row is unindexable.

    Failing loudly sends the event to IDP's retry/DLQ instead of storing a notice the agent's main
    query can never return.
    """
    doc = _document()
    del doc["Sections"][0]["attributes"]["notice_date"]
    with pytest.raises(ValueError, match="notice_date"):
        idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")


# --- the event shapes and the S3-enrichment path ---------------------------------------------------
#
# These cover _derive_output_location / _read_sections, which the notice mapper inherited from the
# deleted item mapper. The behaviour is still live, so the coverage moved rather than went away.


class _FakeReader:
    """Stand-in IdpOutputReader returning canned section results + page images."""

    def __init__(self) -> None:
        """Record the (bucket, prefix) each read was called with."""
        self.calls: list[tuple[str, str]] = []

    def read(self, *, bucket: str, prefix: str) -> dict:
        """Return one enriched section and one page image.

        :param bucket: IDP output bucket the mapper derived.
        :param prefix: document prefix within that bucket.
        :returns: the reader's ``{"sections": [...], "pages": [...]}`` shape.
        """
        self.calls.append((bucket, prefix))
        return {
            "sections": [
                {
                    "section_id": "1",
                    "classification": "LoanRateSettingNotice",
                    "page_indices": [0],
                    "fields": {
                        "counterparty": "MERIDIAN AGENCY SERVICES LLC",
                        "notice_date": "2026-12-26",
                        "amount": 150800000.0,  # float -> must become Decimal
                    },
                    "output_uri": f"s3://{bucket}/{prefix}/sections/1/result.json",
                },
            ],
            "pages": [
                {"page_id": "1", "image_uri": f"s3://{bucket}/{prefix}/pages/1/image.jpg"},
            ],
        }


def test_the_reader_is_called_with_the_bucket_and_prefix_derived_from_a_section_uri() -> None:
    """The event carries only S3 pointers, so the location has to be parsed out of one."""
    reader = _FakeReader()
    idp_event_to_notice(_document(), output_reader=reader, execution_arn="arn:x")
    assert reader.calls == [("idp-out", "Notice.pdf")]


def test_read_field_values_win_over_the_events_own_section_data() -> None:
    """When the read succeeds, the extracted VALUES are what the notice is built from."""
    notice = idp_event_to_notice(_document(), output_reader=_FakeReader(), execution_arn="arn:x")
    assert notice.counterparty == "MERIDIAN AGENCY SERVICES LLC"
    assert notice.notice_date == "2026-12-26"
    assert notice.amount == Decimal("150800000.0")


def test_page_image_locations_are_captured_for_the_preview() -> None:
    """The detail screen renders these directly, with no on-demand call into the pipeline."""
    notice = idp_event_to_notice(_document(), output_reader=_FakeReader(), execution_arn="arn:x")
    assert notice.idp_pages[0]["image_uri"] == "s3://idp-out/Notice.pdf/pages/1/image.jpg"


def test_float_page_values_become_decimal() -> None:
    """boto3's DynamoDB resource rejects floats, so a float anywhere in the row breaks the put."""

    class _FloatPageReader(_FakeReader):
        def read(self, *, bucket: str, prefix: str) -> dict:
            """Return a page carrying a float, as IDP's JSON does.

            :param bucket: IDP output bucket.
            :param prefix: document prefix.
            :returns: the reader shape with a float page attribute.
            """
            out = super().read(bucket=bucket, prefix=prefix)
            out["pages"][0]["width"] = 8.5
            return out

    notice = idp_event_to_notice(
        _document(), output_reader=_FloatPageReader(), execution_arn="arn:x"
    )
    assert isinstance(notice.idp_pages[0]["width"], Decimal)


def test_a_failed_read_degrades_to_the_events_own_section_data() -> None:
    """A transient IDP-S3 problem must not drop the document — the event still carries a class."""

    class _BrokenReader:
        def read(self, *, bucket: str, prefix: str) -> dict:
            """Always fail, standing in for an S3 outage.

            :param bucket: IDP output bucket.
            :param prefix: document prefix.
            :raises RuntimeError: always.
            """
            raise RuntimeError("s3 unavailable")

    notice = idp_event_to_notice(_document(), output_reader=_BrokenReader(), execution_arn="arn:x")
    assert notice.notice_class == "LoanRateSettingNotice"
    assert notice.reference == "WIRE-20260302-EVG"


def test_snakecase_shape_is_supported() -> None:
    """Both event shapes are accepted: the snake_case Step Functions event and the PascalCase
    tracking record. Neither is a fallback for the other -- the hook receives both."""
    snake_case_event = {
        "id": "doc-42",
        "input_key": "notices/n1.pdf",
        "output_bucket": "idp-out",
        "sections": [
            {
                "section_id": "s0",
                "classification": "InterestNotice",
                "extraction_result_uri": "s3://idp-out/notices/n1.pdf/sections/s0/result.json",
                "attributes": {
                    "counterparty": "ACME",
                    "notice_date": "2026-01-15",
                    "amount": "1000.00",
                },
            }
        ],
    }
    notice = idp_event_to_notice(snake_case_event, output_reader=None, execution_arn="arn:x")
    assert notice.notice_id == "idp-doc-42"
    assert notice.notice_class == "InterestNotice"
    assert notice.amount == Decimal("1000.00")


def test_a_string_section_names_the_unresolved_compressed_event() -> None:
    """An unresolved compressed stand-in must be diagnosed here, not crash three frames deep.

    IDP's compressed stand-in degrades ``sections`` to a list of id strings. The mapper cannot
    resolve it (that is ``IdpOutputReader.resolve_document``'s job and it needs S3), but it is where
    the wrong shape lands, so it owns the error message. Undiagnosed, it surfaces as
    ``AttributeError: 'str' object has no attribute 'get'``, which reads like a mapper bug and sent a
    live investigation looking in the wrong module.

    :returns: None.
    """
    with pytest.raises(ValueError, match="unresolved compressed event"):
        idp_event_to_notice({"ObjectKey": "n.pdf", "sections": ["1", "2"]})


# --- The CUJ's canonical fields --------------------------------------------------------------------

# Everything the extraction contract asks for beyond the original five, with values shaped like the
# synthetic notices under data/input/. Keys, not values, are the contract — a rename here without a
# rename in data/input/IDP-EXTRACTION-REQUIREMENTS.md fails tests/input_corpus.
_CANONICAL_ATTRIBUTES = {
    "activity_type": "Interest",
    "global_amount": "3939077.64",
    "fee_amount": "446.67",
    "fee_percentage": "0.375",
    "facility_id_source_raw": "SL-204811",
    "loanx_id": "LX204811XXXX1",
    "cusip": "SYN00031A",
    "isin": "US12345AB67",
    "agent_bank": "Meridian Agency Services LLC",
    "agent_contact_name": "Dana Whitfield",
    "agent_email": "loan.ops@meridian-agent.example",
    "agent_telephone": "+1-555-0100",
    "contract_id": "CT-204811-A",
    "new_contract_id": "CT-204811-B",
    "notice_comment": "only interest notice",
    "notice_date_source_raw": "02-Mar-2026",
}


def _with_canonical(**extra: str) -> dict:
    """Build a document whose section carries every canonical extracted field.

    :param extra: additional attributes to merge in (or override).
    :returns: the IDP completion record.
    """
    doc = _document()
    doc["Sections"][0]["attributes"].update(_CANONICAL_ATTRIBUTES)
    doc["Sections"][0]["attributes"].update(extra)
    return doc


def test_every_canonical_field_reaches_the_notice() -> None:
    """A key the mapper does not read is a field the agent can never see, and nothing reports it."""
    notice = idp_event_to_notice(_with_canonical(), output_reader=None, execution_arn="arn:x")
    assert notice.activity_type == "Interest"
    assert notice.global_amount == Decimal("3939077.64")
    assert notice.fee_amount == Decimal("446.67")
    assert notice.fee_percentage == Decimal("0.375")
    assert notice.facility_id_source_raw == "SL-204811"
    assert notice.loanx_id == "LX204811XXXX1"
    assert notice.cusip == "SYN00031A"
    assert notice.isin == "US12345AB67"
    assert notice.agent_bank == "Meridian Agency Services LLC"
    assert notice.agent_contact_name == "Dana Whitfield"
    assert notice.agent_email == "loan.ops@meridian-agent.example"
    assert notice.agent_telephone == "+1-555-0100"
    assert notice.contract_id == "CT-204811-A"
    assert notice.new_contract_id == "CT-204811-B"
    assert notice.notice_comment == "only interest notice"
    assert notice.notice_date_source_raw == "02-Mar-2026"


def test_provenance_is_derived_not_extracted() -> None:
    """These two are facts about the WRITER, so an extraction must not be able to set them.

    A document claiming `source_system: STRUCTURED_FEED` would otherwise assert feed provenance for a
    notice that came out of the document pipeline — and `is_source_finalized` would then demand a status it has no
    reason to carry.
    """
    notice = idp_event_to_notice(
        _with_canonical(source_system="STRUCTURED_FEED", parse_method="STRUCTURED_FEED"),
        output_reader=None,
        execution_arn="arn:x",
    )
    assert notice.source_system == "OTHER"
    assert notice.parse_method == "IDP"


def test_amount_type_is_derived_from_the_amounts_present() -> None:
    """FEE wins over a share amount, which is the ordering `derive_amount_type` exists to fix."""
    notice = idp_event_to_notice(_with_canonical(), output_reader=None, execution_arn="arn:x")
    assert notice.amount_type == "FEE"


def test_a_global_only_notice_has_no_amount_and_says_so() -> None:
    """The Medium-band case: a total exists, but not one that validates this fund (AM2/AM5).

    `amount` must stay ABSENT rather than being back-filled from the global figure — that absence is
    what reaches the agent as `fields_unavailable`.
    """
    doc = _document()
    attributes = doc["Sections"][0]["attributes"]
    del attributes["amount"]
    attributes["global_amount"] = "418255.00"
    notice = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")
    assert notice.amount is None
    assert notice.global_amount == Decimal("418255.00")
    assert notice.amount_type == "GLOBAL_ONLY"


def test_a_notice_with_no_amounts_at_all_is_unknown() -> None:
    """A rollover notice carries no cash figure; UNKNOWN records that rather than implying zero."""
    doc = _document()
    del doc["Sections"][0]["attributes"]["amount"]
    notice = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")
    assert notice.amount_type == "UNKNOWN"


def test_an_extraction_that_omits_every_optional_field_still_validates() -> None:
    """The minimum viable extraction must produce a usable notice, not a validation error.

    Live extractions will omit most of the canonical fields until the pipeline's configuration is
    updated, so this is the shape the first real document will have — and every omitted field must be
    absent rather than blank, or `fields_unavailable` stops meaning anything.
    """
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    stored = notice.model_dump(exclude_none=True)
    for name in _CANONICAL_ATTRIBUTES:
        assert name not in stored, f"{name} was stored despite not being extracted"


def test_the_source_system_reference_fields_are_never_set_by_extraction() -> None:
    """They are source-system data, not document content, so the document path must leave them absent.

    Asserted even when the extraction supplies them: a document that happens to contain the word
    "Subscribed" must not be able to assert a subscription status the source never confirmed.
    """
    notice = idp_event_to_notice(
        _with_canonical(subscription_status="Subscribed", source_status_raw="Reviewed"),
        output_reader=None,
        execution_arn="arn:x",
    )
    assert notice.subscription_status is None
    assert notice.source_status_raw is None
