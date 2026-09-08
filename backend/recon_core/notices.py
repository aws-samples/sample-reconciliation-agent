"""The ACTUAL side of the reconciliation: extracted counterparty notices.

A notice is REFERENCE data — evidence about a recon item, never the thing that creates one. Nothing
in this module writes to recon-items, and the recon-notices table deliberately has no stream.

Notices are documents, so the available fields vary by notice class. Every optional field here is
``str | None`` rather than ``str``: ``None`` means "this notice's class does not extract that field"
and is surfaced to the agent as ``fields_unavailable``, while ``""`` means "extracted and blank".
Collapsing the two is fail-quiet behaviour: a field the class never carries would become
indistinguishable from one the document left blank.

**The two amount fields are two different quantities and must never be merged.** ``amount`` is the
**fund-attributable** amount — the recipient's share — and is ABSENT when the document supplies
only a facility-wide total. ``global_amount`` carries that total. Agent-bank notices print them side by side
(``Global Amount`` / ``Your Share``), and a notice-wide figure is never valid for fund-level validation.
Absence is what makes that visible: an absent ``amount`` reaches the agent as ``fields_unavailable``, so
the case reads "fund-level amount validation unavailable" rather than silently comparing the wrong two
numbers.

**No validation status lives here.** There is deliberately no ``internal_validation_status``, no
reviewer field and no path by which a human marks a notice reviewed. That is an owner decision, and it
is what makes the HIGH confidence band unreachable on this platform: no notice can ever be
corroborated by a human here, so MEDIUM is the ceiling. Do not add one back without revisiting
that, because the band a case can reach is a product decision and not a scoring detail.
"""

from decimal import Decimal
from typing import Annotated

import boto3
from pydantic import BaseModel, Field

# Keys that must be PRESENT on every stored row even when their value is None, because the
# interceptor's guard distinguishes "resolved to null" from "attribute absent", and refuses the
# ledger write it cannot evaluate rather than passing it.
ALWAYS_STORED = ("extraction_confidence", "confidence_alert_count")


class Notice(BaseModel):
    """One counterparty notice as extracted by the document pipeline."""

    notice_id: str = Field(min_length=1)
    notice_class: str = Field(min_length=1)
    counterparty: str = Field(min_length=1)
    # ISO-8601 date; Excel serials are converted at seed time.
    notice_date: str = Field(min_length=1)

    # Class-dependent extracted fields. None => not extracted for this class.
    fund: str | None = None
    facility: str | None = None
    reference: str | None = None
    # The FUND-ATTRIBUTABLE amount only ("Your Share"). Absent when the document carries a
    # facility-wide total and no share — see the module docstring; that absence is load-bearing.
    amount: Decimal | None = None
    currency: str | None = None

    # The business activity the notice reports, in the source's own vocabulary: Interest, Rateset,
    # Rollover, Commitment Fee, Paydown. Distinct from `notice_class`, which is the document pipeline's
    # classification of the DOCUMENT. A rollover notice proves no cash should move, and that conclusion
    # keys off this field rather than off a classifier label the operator does not control.
    activity_type: str | None = None

    # The facility-wide total across every portfolio the notice covers ("Global Amount"). NEVER valid
    # for fund-level validation, and never a substitute for `amount`.
    global_amount: Decimal | None = None
    # Fee-notice economics. `fee_amount` is what a fee break validates against.
    fee_amount: Decimal | None = None
    fee_percentage: Decimal | None = None

    # Which of the amount fields this notice actually supports, derived at write time by
    # backend/recon_core/notice_derive.derive_amount_type. Stored rather than recomputed on read so the
    # agent and the analyst see the same answer without either of them re-deriving it.
    amount_type: str | None = None

    # The source's own facility identifier, VERBATIM and in whatever namespace it uses (an `SL-`
    # prefix is common). Deliberately NOT normalised against `loanx_id` and never assumed equal to it:
    # absent a governed crosswalk, treating the two as one namespace invents a match.
    facility_id_source_raw: str | None = None
    # Market-standard asset identifiers, each under its own field. Mirrors the ledger's columns of the
    # same names, which is what makes the asset-identity dimension checkable on both sides.
    loanx_id: str | None = None
    cusip: str | None = None
    isin: str | None = None

    # Who sent the notice, and who to chase when expected cash has not arrived. The contact travels on
    # the notice because that is where it is authoritative — the agent bank for THIS facility, not a
    # directory lookup that may be stale.
    agent_bank: str | None = None
    agent_contact_name: str | None = None
    agent_email: str | None = None
    agent_telephone: str | None = None

    # Rate-set and rollover linkage. Surfaced as supporting evidence for the linked interest event,
    # which is the only way a reader can tell an accrual reset from a payment.
    contract_id: str | None = None
    new_contract_id: str | None = None

    # Free-text remarks from the source, e.g. "only interest notice" or a maturity-date warning.
    # Carried verbatim into the evidence trail rather than parsed.
    notice_comment: str | None = None

    # The date EXACTLY as the source printed it, kept beside the ISO `notice_date` it was converted
    # from. Manual extracts have been observed carrying Excel serials (46230), and a conversion with no
    # record of its input cannot be audited or corrected.
    notice_date_source_raw: str | None = None

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
        self._table.put_item(Item=item)

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
