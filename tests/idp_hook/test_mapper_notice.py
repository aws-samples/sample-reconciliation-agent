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


def test_absent_and_blank_stay_distinguishable_in_the_extraction() -> None:
    """None and "" mean different things downstream: unavailable vs extracted-and-blank.

    The distinction now lives entirely in `idp_sections[].fields`, which stores exactly what the extractor
    emitted -- an absent key versus a key whose value is the empty string. Nothing normalises between the
    two on the way in, which is what keeps `fields_unavailable` meaningful.
    """
    doc = _document()
    del doc["Sections"][0]["attributes"]["reference"]
    fields = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x").idp_sections[0][
        "fields"
    ]
    assert "reference" not in fields

    doc["Sections"][0]["attributes"]["reference"] = ""
    fields = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x").idp_sections[0][
        "fields"
    ]
    assert fields["reference"] == ""


def test_a_non_index_field_reaches_the_notice_only_through_idp_sections() -> None:
    """The whole shape of the model: extracted content is carried, not promoted.

    `amount` is the one worth asserting by name. It is the field a reconciliation actually compares, so
    it is the most tempting to promote, and `search_notices` resolves it out of this map instead --
    which is what lets the extraction rename it without a code change here.
    """
    notice = idp_event_to_notice(_document(), output_reader=None, execution_arn="arn:x")
    fields = notice.idp_sections[0]["fields"]
    assert fields["amount"] == "9640.18"
    for name in ("amount", "fund", "facility", "currency", "activity_type"):
        assert not hasattr(notice, name), f"{name} was promoted onto the model"


def test_an_unparseable_amount_is_carried_rather_than_rejected() -> None:
    """The mapper does not parse extracted numbers, so it cannot reject one -- and should not.

    Dead-lettering a whole document over one malformed field loses every other field on it. The value is
    stored exactly as printed and the comparison happens in `search_notices`, which reports a value it
    could not parse in `fields_unavailable` -- so the amount is never silently treated as matched, and
    one bad row cannot break every amount search against the table.
    """
    doc = _document()
    doc["Sections"][0]["attributes"]["amount"] = "n/a"
    notice = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")
    assert notice.idp_sections[0]["fields"]["amount"] == "n/a"


def test_missing_object_key_raises() -> None:
    """Without an ObjectKey there is no deterministic id, so re-delivery would duplicate."""
    with pytest.raises(ValueError, match="ObjectKey"):
        idp_event_to_notice({"PageCount": 1}, output_reader=None, execution_arn="arn:x")


def test_a_document_with_no_extractable_date_maps_with_the_date_absent() -> None:
    """A document that prints no date maps, with the date ABSENT rather than rejected or invented.

    The model comment carries the reasoning: dead-lettering loses a document recon can still say useful
    things about, and defaulting to the pipeline's start time substitutes a processing timestamp for an
    issue date, so a stale notice appears to fall inside a recent window.

    None, not `""`: `search_notices` reports absence as `fields_unavailable`, whereas a blank string is
    a value and reads as a date the extractor resolved to nothing.
    """
    doc = _document()
    del doc["Sections"][0]["attributes"]["notice_date"]
    notice = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")
    assert notice.idp_sections[0]["fields"].get("notice_date") is None
    # The rest of the notice still maps, which is the point of not dead-lettering it.
    assert notice.idp_sections[0]["fields"].get("counterparty")
    assert notice.notice_class


def test_a_dateless_notice_never_borrows_the_pipeline_start_time() -> None:
    """The specific substitution this design rejects, asserted so nobody re-adds it as a kindness.

    `idp_tracking.initial_event_time` is a PROCESSING timestamp and is already stored under its own
    name. If it ever leaks into `notice_date`, a February notice processed in September starts matching
    September date windows with its date apparently aligning — `_matches` compares a present date as a
    real one, so the agent is never told the comparison was unavailable.
    """
    doc = _document()
    del doc["Sections"][0]["attributes"]["notice_date"]
    tracking = {"initial_event_time": "2026-09-09T21:14:59Z", "workflow_status": "SUCCEEDED"}
    notice = idp_event_to_notice(
        doc, output_reader=None, execution_arn="arn:x", idp_tracking=tracking
    )
    assert notice.idp_sections[0]["fields"].get("notice_date") is None
    assert notice.idp_tracking["initial_event_time"] == "2026-09-09T21:14:59Z"


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
    assert notice.idp_sections[0]["fields"].get("counterparty") == "MERIDIAN AGENCY SERVICES LLC"
    assert notice.idp_sections[0]["fields"].get("notice_date") == "2026-12-26"
    assert notice.idp_sections[0]["fields"]["amount"] == Decimal("150800000.0")


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
    assert notice.idp_sections[0]["fields"].get("reference") == "WIRE-20260302-EVG"


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
    assert notice.idp_sections[0]["fields"]["amount"] == "1000.00"


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


def test_the_promoted_fields_still_reach_the_notice() -> None:
    """The index keys are attributes; everything else the extractor read is only in `idp_sections`.

    See PROMOTED_EXTRACTED_FIELDS in backend/recon_core/notices.py for the rule that decides which is
    which -- a DynamoDB index key attribute has to be declared on the table, so it cannot live in a
    nested map.
    """
    notice = idp_event_to_notice(_with_canonical(), output_reader=None, execution_arn="arn:x")
    assert notice.idp_sections[0]["fields"].get("counterparty")
    assert notice.idp_sections[0]["fields"].get("notice_date")
    assert notice.idp_sections[0]["fields"]["activity_type"] == "Interest"


def test_extracted_fields_survive_in_idp_sections() -> None:
    """Every extracted field must be READABLE through `idp_sections`, or the model shape loses data.

    Extracted content is not a model attribute, which is only safe because `idp_sections[].fields`
    carries the extractor's `inference_result` verbatim. That is the guarantee asserted here, and it is
    the one a change that stopped embedding sections would break silently everywhere else. Values are
    compared as the STRINGS the extractor emitted, since the mapper does not parse them.
    """
    notice = idp_event_to_notice(_with_canonical(), output_reader=None, execution_arn="arn:x")
    fields = notice.idp_sections[0]["fields"]
    for name, expected in _CANONICAL_ATTRIBUTES.items():
        assert fields[name] == expected, f"{name} is no longer reachable via idp_sections"
    # And they really are NOT attributes any more, so nothing reads them off the model by habit.
    for name in _CANONICAL_ATTRIBUTES:
        if name == "activity_type":
            continue  # still promoted -- see the test above
        assert not hasattr(notice, name), f"{name} was re-promoted onto the model"


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


def test_a_global_only_notice_has_no_amount_and_says_so() -> None:
    """The Medium-band case: a total exists, but not one that validates this fund (AM2/AM5).

    `amount` must stay ABSENT rather than being back-filled from the global figure — that absence is
    what reaches the agent as `fields_unavailable`. Neither figure is a model attribute, so neither can
    be substituted for the other by a reader that grabs whichever one exists -- a consumer has to name
    the field it means, and the share simply is not there to be named.
    """
    doc = _document()
    attributes = doc["Sections"][0]["attributes"]
    del attributes["amount"]
    attributes["global_amount"] = "418255.00"
    notice = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")
    fields = notice.idp_sections[0]["fields"]
    assert "amount" not in fields, "the share must stay absent, never back-filled from the total"
    assert fields["global_amount"] == "418255.00"


def test_a_notice_with_no_amounts_at_all_leaves_amount_absent() -> None:
    """A rollover notice carries no cash figure, and the field stays absent rather than becoming zero.

    Absence is what `search_notices` reports as `fields_unavailable`; a zero would read as a real figure
    the extractor resolved, and a rollover proves no cash was due rather than that nil was.
    """
    doc = _document()
    del doc["Sections"][0]["attributes"]["amount"]
    notice = idp_event_to_notice(doc, output_reader=None, execution_arn="arn:x")
    assert "amount" not in notice.idp_sections[0]["fields"]


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
