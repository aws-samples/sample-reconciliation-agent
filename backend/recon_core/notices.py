"""The ACTUAL side of the reconciliation: extracted counterparty notices.

A notice is REFERENCE data — evidence about a recon item, never the thing that creates one. Nothing
in this module writes to recon-items, and the recon-notices table deliberately has no stream.

Notices are documents, so the available fields vary by notice class. Every optional field here is
``str | None`` rather than ``str``: ``None`` means "this notice's class does not extract that field"
and is surfaced to the agent as ``fields_unavailable``, while ``""`` means "extracted and blank".
Collapsing the two is fail-quiet behaviour: a field the class never carries would become
indistinguishable from one the document left blank.

**Extracted content does not live in this model.** The attributes below are recon's own bookkeeping plus
:data:`PROMOTED_EXTRACTED_FIELDS`, and nothing else. Everything the extractor read is carried verbatim
in ``idp_sections[].fields``, under the extractor's own key names, which is why a field the pipeline
adds or renames needs no change here. ``search_notices`` resolves a filter against that map, so an
extracted field is queryable without being an attribute.

**Amounts are a case where that matters.** Agent-bank notices print a facility-wide total beside the
recipient's share (``Global Amount`` / ``Your Share``), and the facility-wide figure is never valid for
fund-level validation. Neither is promoted, so neither can be silently substituted for the other by a
reader that grabs whichever attribute exists — a consumer that wants the share has to name the field it
means. Absence stays visible: a filter on a share the document did not print comes back in
``fields_unavailable``, so the case reads "fund-level amount validation unavailable" rather than
comparing the wrong two numbers.

**No validation status lives here.** There is deliberately no ``internal_validation_status``, no
reviewer field and no path by which a human marks a notice reviewed. That is an owner decision, and it
is what makes the HIGH confidence band unreachable on this platform: no notice can ever be
corroborated by a human here, so MEDIUM is the ceiling. Do not add one back without revisiting
that, because the band a case can reach is a product decision and not a scoring detail.
"""

import json
from decimal import Decimal
from typing import Annotated

import boto3
from pydantic import BaseModel, Field

# Keys that must be PRESENT on every stored row even when their value is None, because the
# interceptor's guard distinguishes "resolved to null" from "attribute absent", and refuses the
# ledger write it cannot evaluate rather than passing it.
ALWAYS_STORED = ("extraction_confidence", "confidence_alert_count")

# The ONLY extracted field names recon hardcodes. Every other extracted field reaches its reader
# through `Notice.idp_sections[].fields`, under the name the extraction configuration gave it, and has
# no entry anywhere in this repository.
#
# The bar for membership is that something must be UNABLE to read a nested map. A DynamoDB index key
# attribute must be declared on the table, so the three below clear it; nothing else does. A name here
# is one recon has to keep in step with a configuration in another repository, and when it drifts the
# mapper stores the field as absent and the agent reads "this notice class does not carry that field" --
# a confident false negative rather than an error. That is the whole cost, and it is why the list is
# closed. `tests/input_corpus/test_extraction_requirements.py` asserts the mapper reads exactly these.
INDEX_KEY_FIELDS = (
    "counterparty",  # counterparty-index HASH
    "notice_date",  # counterparty-index RANGE
    "reference",  # reference-index HASH
)

# Read as fallbacks for two of the index keys and never stored under these names: a document that
# prints only an effective date, or names the obligor as `borrower`, still has to land in the index.
INDEX_KEY_ALIASES = ("value_date", "borrower")

PROMOTED_EXTRACTED_FIELDS = INDEX_KEY_FIELDS + INDEX_KEY_ALIASES


class Notice(BaseModel):
    """One counterparty notice as extracted by the document pipeline."""

    notice_id: str = Field(min_length=1)
    notice_class: str = Field(min_length=1)
    counterparty: str = Field(min_length=1)
    # ISO-8601 date the SOURCE printed. The `counterparty-index` RANGE key, which is the only reason it
    # is an attribute at all.
    #
    # Optional, and never back-filled from an ingest timestamp. A document that prints no date of any
    # kind is stored with this ABSENT rather than rejected: the corpus fax cover carries a counterparty
    # and an agent bank and is worth keeping. Substituting `idp_started_at` would put a PROCESSING
    # timestamp in an ISSUE date, and `_matches` compares a present date as a real one -- so a February
    # notice processed in September would satisfy a September window with its date apparently aligning,
    # turning "cannot check" into "checks out". The ingest time is stored under its own name for readers
    # that want it.
    #
    # ⚠️ DynamoDB omits an item with no range key from `counterparty-index`, so a dateless notice is
    # reachable only by `notice_id`, by the Documents tab, or by the scan path. `search_notices` reports
    # the field in `fields_unavailable`, so the gap is visible rather than silent.
    notice_date: str | None = None

    # `reference-index` HASH key -- again, the only reason this is an attribute.
    reference: str | None = None

    # ⚠️ NO EXTRACTED FIELD BELONGS HERE. The three above are the complete set, and
    # :data:`PROMOTED_EXTRACTED_FIELDS` states the rule they satisfy: a DynamoDB index key attribute has
    # to be declared on the table, so it cannot live in a nested map. Nothing else clears that bar.
    #
    # An extracted field reaches every reader through `idp_sections[].fields` below, under the name the
    # extractor gave it. `search_notices` resolves a filter against that map, so adding an attribute here
    # buys a flatter shape and costs a name recon must keep in step with a configuration in another
    # repository -- and when that drifts, the row stores the field as absent and the agent reads "this
    # notice class does not carry that field", which is a confident false negative rather than an error.

    # Provenance derived by whichever component wrote the row, never extracted from the document and
    # never supplied by a caller. On the document path these are constant: OTHER + IDP.
    source_system: str | None = None
    parse_method: str | None = None

    # Reference data the SOURCE SYSTEM supplies, not the document, so both stay absent until a
    # structured-feed adapter exists. Absence is the correct state, not missing data: a blank
    # subscription status is itself the signal that routing is ambiguous and needs a human to choose.
    subscription_status: str | None = None
    source_status_raw: str | None = None

    # Load-bearing for the interceptor's write refusal — never defaulted. An absent value blocks
    # the write; a defaulted one would wave it through on evidence nobody scored.
    # Decimal, not float: boto3's DynamoDB resource raises TypeError on float, so a float here
    # would make every put fail at runtime while every unit test on the model passed.
    # REQUIRED but NULLABLE, and the distinction is the whole point. Omitting either key fails
    # validation. An explicit None means "the extraction could not be resolved" — which the
    # interceptor treats as a REFUSAL, not as zero. The mapper (Task 19) needs this third state
    # because IDP's own ConfidenceAlertCount is NULL on live documents and the per-section counts
    # exist only when the output-S3 read succeeded; dropping the notice on a transient read failure
    # would be worse, and defaulting to 0 would silently deactivate the guard.
    #
    # Annotated[...] | None, not `int | None = Field(ge=0)`: pydantic applies a bare Field
    # constraint to the whole union and rejects the None branch.
    extraction_confidence: Annotated[Decimal, Field(ge=0, le=1)] | None = Field(...)
    confidence_alert_count: Annotated[int, Field(ge=0)] | None = Field(...)

    # Provenance of the extraction, for the audit trail and the page-preview lookup.
    source_document: str | None = None
    idp_execution_arn: str | None = None
    # Page-image locations, embedded at ingest so the detail screen renders previews without any
    # on-demand call into the document pipeline. Empty list, not None: "no previews" is a real
    # answer here, unlike the class-dependent fields above.
    idp_pages: list[dict] = Field(default_factory=list)
    # Per-section extraction, embedded at ingest for the same reason as `idp_pages` above: the
    # Documents tab renders what the extractor read WITHOUT an on-demand call into the document
    # pipeline. Each entry is
    #   {section_id, classification, page_ids, fields, confidences, mean_confidence, alert_count}
    # where `fields` is IDP's `inference_result` verbatim and `confidences` is the flattened
    # `explainability_info` (see backend/idp_hook/explainability.py, which is the ONLY
    # implementation of that flattening -- the console must not grow a second one).
    #
    # Empty list, not None: "this section carried no explainability data" is a real answer, and the
    # tab distinguishes it from "no notice row at all".
    idp_sections: list[dict] = Field(default_factory=list)
    # Set ONLY when `idp_sections` had to be dropped to keep the row under DynamoDB's item limit --
    # see NoticeStore.put, which explains why this one place does not fail loudly.
    idp_sections_omitted: str | None = None

    # Discriminates the two row kinds that now share `notice_id = "idp-<ObjectKey>"`: "notice" (this
    # model, an extracted document) or "document" (a tracking-only row written by
    # NoticeStore.put_document_record for a document the pipeline reached a terminal status on
    # without recon being able to map a notice -- see that method). EVERY READER must treat an
    # ABSENT `record_kind` as "notice", because every row written before this field existed has
    # none; the default here only covers rows that round-trip through THIS model, not the plain-dict
    # writes `put_document_record` makes.
    record_kind: str = "notice"

    # The IDP pipeline's OWN tracking/progress metadata for this document (see
    # backend/idp_hook/tracking.build_tracking_snapshot) -- status, timings, config version, and
    # per-section alert flags -- embedded so the Documents tab renders it WITHOUT a live call into
    # IDP's AppSync API, which is the whole point of this migration. `None` on any notice written
    # before this field existed, or whose hook run captured no snapshot. `_idp_gsi_attrs` derives
    # `idp_record`/`idp_started_at`, the new GSI's key attributes, from this dict's
    # `initial_event_time` -- see that helper for why those live as separate top-level attributes
    # rather than being read out of this map at query time.
    idp_tracking: dict | None = None


# DynamoDB's hard per-item ceiling is 400 KB. The margin covers the difference between our
# JSON estimate and DynamoDB's own attribute-name-inclusive accounting, which we cannot measure
# exactly from here.
MAX_ITEM_BYTES = 380_000


def _fit_item(item: dict) -> dict:
    """Drop ``idp_sections`` if keeping it would push the row past DynamoDB's item limit.

    This is a DELIBERATE exception to the fail-loudly convention, and the only one in this module.
    Everywhere else a bad value must raise, because a silently-wrong notice is worse than no notice.
    Here the trade runs the other way: the row feeds the deterministic matcher AND the gateway
    interceptor's write refusal, so failing the put would take out reconciliation for that notice to
    protect a display convenience. `idp_sections` is the only unbounded attribute -- its size is a
    function of somebody else's document schema -- so it is the one that yields. `idp_tracking` is
    bounded (a fixed key set plus a `sections_meta` entry per section, not per extracted field), so
    it never competes for this trim: `idp_sections` remains the only attribute that can push a row
    over the limit.

    The drop is RECORDED rather than silent: ``idp_sections_omitted`` carries the reason, the tab
    shows a named gap, and no aggregate is affected because ``extraction_confidence`` and
    ``confidence_alert_count`` are separate scalars.

    :param item: the marshalled DynamoDB item, already ``exclude_none``'d.
    :returns: the item unchanged when it fits, otherwise a copy without ``idp_sections``.
    """
    # `default=str` because the item carries Decimals, which json cannot serialise. This is an
    # estimate of DynamoDB's own sizing, not a reimplementation of it -- hence the margin above.
    size = len(json.dumps(item, default=str).encode("utf-8"))
    if size <= MAX_ITEM_BYTES or "idp_sections" not in item:
        return item
    trimmed = {k: v for k, v in item.items() if k != "idp_sections"}
    trimmed["idp_sections_omitted"] = (
        f"the extraction was {size} bytes, over the {MAX_ITEM_BYTES}-byte row budget, "
        "so the per-field detail was not stored"
    )
    return trimmed


def _idp_gsi_attrs(idp_tracking: dict | None) -> dict:
    """Derive the ``idp-document-index`` GSI's key attributes from an IDP tracking snapshot.

    The ONE place this derivation happens, used by both ``NoticeStore.put`` and
    ``NoticeStore.put_document_record``, so the two call sites can never disagree on where
    ``idp_started_at`` comes from. A GSI key cannot live inside a nested map, so
    ``idp_record``/``idp_started_at`` must be promoted to top-level item attributes rather than
    read out of ``idp_tracking`` at query time -- that promotion is what this function does.

    No snapshot at all, or a snapshot that has not yet been stamped with ``initial_event_time``
    (see ``backend/idp_hook/tracking.py``'s absence-is-a-fact rule -- that field is genuinely
    absent until the pipeline reports a start), yields NEITHER attribute. That is CORRECT, not a
    gap: a row missing either half of a GSI's key simply does not enter that index, so a document
    with no known start time is properly invisible to a listing keyed on "when did ingestion
    start" rather than showing up under a fabricated timestamp. Do not "fix" this by defaulting one
    half only.

    :param idp_tracking: the embedded IDP tracking snapshot, or ``None``.
    :returns: ``{"idp_record": "document", "idp_started_at": <value>}`` when the snapshot carries a
        resolvable ``initial_event_time``, otherwise an empty dict.
    """
    if idp_tracking and idp_tracking.get("initial_event_time"):
        return {"idp_record": "document", "idp_started_at": idp_tracking["initial_event_time"]}
    return {}


class NoticeStore:
    """DynamoDB accessor for Notice rows in the recon-notices table."""

    def __init__(self, *, table_name: str) -> None:
        """Bind to the named DynamoDB table via the default boto3 session.

        :param table_name: name of the recon-notices table.
        """
        self._table = boto3.resource("dynamodb").Table(table_name)

    def put(self, *, notice: Notice) -> None:
        """Write a notice, overwriting any existing row with the same notice_id.

        Unconditional on purpose. A notice has no lifecycle to protect: re-extracting the same
        document should replace the stale extraction, and there is no case to re-drive because
        this table has no stream. Do NOT add a conditional put here: an extracted document is
        evidence ABOUT a reconciliation item, never the thing that creates or advances one.

        Unextracted (``None``) fields are EXCLUDED from the stored row rather than written as NULL,
        so ``fields_unavailable`` and the interceptor's guard can both key off attribute absence.
        The ``ALWAYS_STORED`` keys are the exception: they are written even when None, because for
        those two "resolved to null" and "attribute absent" mean different things to the guard.

        :param notice: the validated notice record to store.
        :returns: None.
        """
        item = notice.model_dump(exclude_none=True)
        for key in ALWAYS_STORED:
            item.setdefault(key, None)

        # See _idp_gsi_attrs's docstring for the "neither attribute" semantics when there is no
        # usable snapshot -- deliberate, not a gap.
        item.update(_idp_gsi_attrs(item.get("idp_tracking")))

        item = _fit_item(item)
        self._table.put_item(Item=item)

    def put_document_record(self, *, record: dict) -> None:
        """Write a tracking-only row for a document the pipeline never mapped to a notice.

        Covers a FAILED execution, or a SUCCEEDED one whose document extracted no ``notice_date``.

        Deliberately does NOT construct a :class:`Notice`: a tracking row has no ``notice_date``
        and no ``counterparty``, both of which ``Notice`` requires, and forcing a fabricated value
        onto either is exactly the fail-quiet behaviour this module exists to avoid. ``record`` is
        written as a plain dict.

        Shares ``notice_id = "idp-<ObjectKey>"`` with the notice row for the same document rather
        than using a separate id namespace, so a document that FAILS and is later reprocessed
        successfully overwrites its own tracking row instead of leaving two rows behind (one of
        which would otherwise linger in the Documents tab forever). The write is conditioned so it
        can only ever overwrite an absent row or another tracking row -- see the
        ``ConditionExpression`` below -- never a real notice.

        The two GSI key attributes (``idp_record``/``idp_started_at``) are DERIVED from
        ``record["idp_tracking"]`` via ``_idp_gsi_attrs`` -- the same helper ``put`` uses -- rather
        than accepted as independently-supplied values. A caller-supplied copy could silently
        disagree with the snapshot (e.g. a bug that stamps ``idp_started_at`` with failure-detection
        time instead of ingestion-start time); deriving both from one source makes that
        disagreement impossible instead of merely unlikely. Any ``idp_record``/``idp_started_at``
        already present on ``record`` are overwritten by the derived values.

        :param record: the plain item to store. Must carry a non-blank ``notice_id``, a
            ``record_kind`` of exactly ``"document"``, and an ``idp_tracking`` snapshot with a
            resolvable ``initial_event_time`` (see ``_idp_gsi_attrs``).
        :returns: None.
        :raises ValueError: if ``notice_id`` is missing or blank, if ``record_kind`` is not exactly
            ``"document"``, or if ``idp_tracking`` yields no usable GSI attributes. Nothing here is
            defaulted: a caller that cannot supply these has a bug that must surface, not a row
            that silently fails to index.
        """
        notice_id = record.get("notice_id")
        if not isinstance(notice_id, str) or not notice_id.strip():
            raise ValueError("put_document_record requires a non-blank 'notice_id'")

        # Must be the EXACT literal "document", not merely present/non-blank -- this is the same
        # literal the ConditionExpression below compares an EXISTING row's stored record_kind
        # against (":doc"). That coupling is invisible from here, which is exactly why it needs a
        # comment: if a caller bug or typo wrote a tracking row with record_kind="notice" (or any
        # other non-"document" value), a mere non-blank check would have let it through -- it would
        # then fail the ConditionExpression on the NEXT legitimate call for the same notice_id
        # (stored record_kind != "document"), landing in the swallow below and silently dropping
        # new tracking data while protecting a corrupted row as if it were a real notice. That is
        # exactly the failure the swallow's own comment says must never happen. An equality check
        # also has no blind spot for non-string falsy values like `0`/`False`, unlike a blank
        # check.
        if record.get("record_kind") != "document":
            raise ValueError("put_document_record requires record_kind == 'document'")

        gsi_attrs = _idp_gsi_attrs(record.get("idp_tracking"))
        if not gsi_attrs:
            raise ValueError(
                "put_document_record requires an idp_tracking snapshot with a resolvable "
                "initial_event_time"
            )
        record = {**record, **gsi_attrs}

        try:
            self._table.put_item(
                Item=record,
                # Permits the write when EITHER no row exists yet for this notice_id, OR the
                # existing row is itself a tracking row (record_kind == "document"). Blocks it when
                # the existing row is a real notice -- including a LEGACY notice with no record_kind
                # attribute at all, because a missing attribute makes `record_kind = :doc` evaluate
                # false rather than true, which is exactly the absent-means-"notice" convention this
                # module follows everywhere else.
                ConditionExpression="attribute_not_exists(notice_id) OR record_kind = :doc",
                ExpressionAttributeValues={":doc": "document"},
            )
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            # DELIBERATE no-op, scoped to this ONE exception for this ONE reason -- this is NOT a
            # general fallback, and this module's convention is fail loudly everywhere else. A
            # reprocess that FAILS must not be allowed to clobber a good notice already written for
            # this notice_id: the matcher may already have cited that notice's extracted data, and
            # overwriting it with a failure reason would destroy live evidence to record a
            # transient error. The existing notice stands unchanged; the failure is visible in the
            # hook's own log instead of in this table.
            pass
        # No _fit_item call here, unlike put(): a tracking row carries no idp_sections (there is no
        # extraction to embed), and idp_tracking itself is bounded -- see _fit_item's docstring --
        # so nothing in this row can ever hit the item-size trim that function exists for.

    def get(self, *, notice_id: str) -> Notice:
        """Fetch a notice by id.

        :param notice_id: partition key of the notice.
        :returns: the validated notice.
        :raises KeyError: if no such notice exists — never a None or empty stand-in.
        """
        return Notice.model_validate(self.raw(notice_id=notice_id))

    def raw(self, *, notice_id: str) -> dict[str, object]:
        """Fetch a notice's stored attributes without model validation.

        Needed by the gateway interceptor, which must distinguish an ABSENT
        ``confidence_alert_count`` from a zero one and therefore cannot go through a model whose
        validation would reject the absent case.

        :param notice_id: partition key of the notice.
        :returns: the raw DynamoDB item as a plain dict.
        :raises KeyError: if no such notice exists.
        """
        resp = self._table.get_item(Key={"notice_id": notice_id})
        if "Item" not in resp:
            raise KeyError(f"notice {notice_id} not found")
        return resp["Item"]
