"""Shared proposal-service primitives used by BOTH agent backends.

The runtime container (Strands loop) and the harness worker both derive the ledger reference, and
this module is its single home so the two cannot disagree about a trust-relevant rule:

**The ledger reference is never model-supplied.** It is derived from the references the
``search_ledger`` tool actually returned during the investigation: exactly ONE distinct
reference ⇒ that is the actionable reference; zero or multiple ⇒ no clean action exists and
the item must escalate to a human (``None``).

Execution/resolution of a proposal is equally shared — see
``backend.recon_core.auto_resolve.autonomous_execute`` / ``maybe_auto_resolve``, which both
backends' workers call.
"""

from decimal import Decimal
from typing import Any, Iterable, Optional


def to_decimal_safe(value: Any) -> Any:
    """Deep-convert floats to Decimal for DynamoDB persistence.

    Trace steps embed raw tool inputs/outputs (e.g. a ``search_ledger`` call with float
    ``min_amount``/``max_amount`` arguments) — boto3's DynamoDB serializer rejects Python
    floats ("Float types are not supported"), which crashed proposal persistence the first
    time a model searched by amount range. Applied to the whole steps structure by BOTH
    backends' persist paths.

    :param value: any JSON-shaped structure (dict/list/scalars).
    :returns: the same structure with every float converted to Decimal.
    """
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: to_decimal_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_decimal_safe(v) for v in value]
    return value


def derive_reference(references: Iterable[str]) -> Optional[str]:
    """Derive the single actionable ledger reference from observed search results.

    :param references: every ``reference`` value seen across the investigation's
        ``search_ledger`` results (callers adapt their own result shapes; duplicates fine).
    :returns: the sole distinct reference, or None when 0 or >1 distinct references were
        observed (⇒ non-executable ⇒ forced escalation).
    """
    distinct = {r for r in references if isinstance(r, str) and r}
    if len(distinct) == 1:
        return next(iter(distinct))
    return None


def judge_cited_evidence(
    *,
    notice_rows: list[dict],
    guidance_results: list[dict],
    workflow_types_table: str = "",
    ddb=None,
) -> tuple[str, str]:
    """Decide whether a proposal's cited evidence may be written from, for either backend.

    Shared rather than duplicated because the two backends must reach the SAME verdict for the same
    investigation. A divergence would surface only much later, as a gateway denial on whichever backend
    happened to run that item — the hardest class of bug this platform can produce.

    Shape adaptation stays with the caller, as it already does for :func:`derive_reference`: each backend
    knows how its own tool outputs are packed, and this function only wants the rows.

    :param notice_rows: notice rows from every ``search_notices`` call in the investigation.
    :param guidance_results: retrieval results from every guidance call, each with its ``metadata``.
    :param workflow_types_table: the workflow-types table, for resolving whether an operator enabled
        correspondence as an evidence source. Empty means "do not ask", which resolves to NOT enabled —
        appropriate for a caller with no configured table, and never a silent pass.
    :param ddb: injectable DynamoDB resource (tests).
    :returns: ``(verdict, reason)``.
    """
    from backend.recon_core.evidence_quality import decide_evidence_quality, kb_evidence_enabled

    # Only asked when guidance was actually cited AND no notice was: in every other case the answer
    # cannot change the verdict, and this saves a table read on the common path.
    enabled = False
    if guidance_results and not notice_rows and workflow_types_table:
        enabled = kb_evidence_enabled(table_name=workflow_types_table, ddb=ddb)
    return decide_evidence_quality(
        notices=notice_rows, kb_documents=guidance_results, kb_evidence_enabled=enabled
    )
