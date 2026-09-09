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


# Cap on how many notice rows are persisted for display. DynamoDB items stop at 400 KB and nothing
# bounds how many notices a search can match, so a runaway result set must not be able to fail the
# whole proposal write for the sake of a display attribute. The guard drops whole SURPLUS ROWS and
# reports the count as `omitted` — a partially written row would be indistinguishable from a real
# one, which is the bug this whole mechanism exists to fix. Real searches return well under ten.
MAX_PERSISTED_NOTICE_ROWS = 50


def as_result_dict(result: object) -> dict | None:
    """Coerce one recorded tool result into a dict, tolerant of the LIVE shape.

    The live AgentCore gateway returns MCP tool results as ``text`` content parts — a
    stringified-JSON blob — so ``stream._extract_payload`` yields a ``str`` and
    ``tool_outputs["search_ledger"]`` holds JSON *strings*, not dicts (unit-test fixtures use
    structured ``{"json": {...}}`` parts, which is why this went unnoticed). A raw ``str`` here
    silently produced zero references → ``proposed_action=None`` → every clean single-match case
    escalated instead of auto-resolving, regardless of confidence. Parse the string; anything
    that is neither a dict nor JSON-decodable to one is skipped.

    Lives here rather than in the harness because both backends' result adapters need it: the
    runtime accumulates already-parsed dicts, the harness JSON strings, and one function that
    accepts either is what lets them share a single derivation downstream.

    :param result: one recorded tool result (dict | JSON str | other).
    :returns: the result as a dict, or None when it is not / does not decode to one.
    """
    import json

    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            decoded = json.loads(result)
        except (json.JSONDecodeError, ValueError):
            return None
        return decoded if isinstance(decoded, dict) else None
    return None


def notice_search_summary(*, results: list) -> dict:
    """Collect the FULL result set of a run's ``search_notices`` calls, for persistence.

    Exists because the trace's ``tool_output`` is a ~600-character display summary
    (``harness_agent.stream._summarize`` / the runtime's ``_summarize_tool_output``) and one notice
    row exceeds that — so the stored trace holds a JSON *fragment*. The UI used to re-parse that
    fragment, fail, and report "matched no notices" on cases that had matched several. The rows
    themselves were never lost, only never persisted.

    Shared by BOTH backends, and takes the RESULT LIST rather than a tool-outputs container because
    that is the only input shape the two have in common: the harness holds
    ``StreamResult.tool_outputs["search_notices"]``, the runtime accumulates results inside
    ``strands_investigator._call``. One derivation means the two cannot show different notices for
    the same investigation.

    Rows are returned whole and untruncated. The shape mirrors what the panel renders, so there is
    no second derivation step that could disagree with this one.

    NOT the input to the evidence verdict. ``judge_cited_evidence`` reads the raw, uncapped rows on
    both backends; feeding it this summary would let ``MAX_PERSISTED_NOTICE_ROWS`` move a verdict
    that gates a ledger write.

    :param results: the recorded ``search_notices`` results (dicts and/or JSON strings). Empty when
        the investigation never called the tool.
    :returns: ``{"searched", "rows", "matched_on", "error", "omitted"}`` — ``searched`` is whether any
        ``search_notices`` result was recorded at all, ``rows`` the de-duplicated notices in
        first-seen order, ``matched_on`` the merged match attributes, ``error`` the first tool-level
        error string (or None), and ``omitted`` how many rows the size guard dropped.
    """
    rows: list[dict] = []
    matched_on: list[str] = []
    error: str | None = None
    seen: set[str] = set()
    omitted = 0

    for result in results:
        parsed = as_result_dict(result)
        if parsed is None:
            continue
        # A tool-level failure puts {"error": ...} here instead of rows. The first one wins: the
        # panel reports that the investigation ran WITHOUT notice evidence, which one message says.
        if error is None and isinstance(parsed.get("error"), str):
            error = parsed["error"]
        for attribute in parsed.get("matched_on", []) or []:
            if isinstance(attribute, str) and attribute not in matched_on:
                matched_on.append(attribute)
        for row in parsed.get("rows", []) or []:
            if not isinstance(row, dict):
                continue
            # De-duplicated by id: the agent narrows by calling search_notices repeatedly, and the
            # same notice returned twice is one piece of evidence. A row with no id cannot be
            # de-duplicated, so it is kept rather than dropped.
            notice_id = row.get("notice_id")
            key = str(notice_id) if notice_id else ""
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            if len(rows) >= MAX_PERSISTED_NOTICE_ROWS:
                omitted += 1
                continue
            rows.append(row)

    return {
        # Whether the tool ran at all, kept separate from an empty `rows`: "never searched" and
        # "searched and matched nothing" lead a reviewer to opposite conclusions about the case.
        "searched": bool(results),
        "rows": rows,
        "matched_on": matched_on,
        "error": error,
        "omitted": omitted,
    }


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
