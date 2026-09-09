"""Tier-1 deterministic general-ledger match.

Items sourced from an extracted document arrive with no sides, so there is nothing to compare them
against except the ledger. This module looks the document up there, through a query Lambda that runs
Athena over S3, and matches on the economic identity of the cash item: the borrower or counterparty
account name, an amount within tolerance, and the entry type, meaning the credit or debit direction.

What it deliberately never keys on is the document's filename or reference. A real ledger's
``reference`` column holds a wire or transaction code, and matching an uploaded file name against it
produces coincidences, not matches.

An item auto-clears deterministically only when exactly one ledger row satisfies all three
attributes, with no LLM involved. Zero matches, more than one match, or any missing input all send
the item to the agent instead, with the ledger rows attached as context so the agent reasons over
real data.
"""

import json
import logging
import os
from dataclasses import dataclass
from typing import Callable, Optional

import boto3

from backend.recon_core.schema import ReconItem

logger = logging.getLogger(__name__)

# Absolute tolerance, in currency units, for an amount to count as a deterministic match. It mirrors
# the cash rule the reconciliation engine applies, so a two-sided and a ledger-side match do not
# disagree about what "same amount" means.
TOLERANCE = 0.05

# A numeric leaf only counts as a candidate amount if its key contains one of these tokens. Extracted
# documents carry plenty of other numbers — rates, day counts, page numbers — and matching a ledger
# amount against one of those would clear a case on a coincidence.
_AMOUNT_TOKENS = ("amount", "payment", "share", "total", "principal", "interest")


def _walk_amounts(node, key_hint: str, out: set) -> None:
    """Walk a nested structure and collect the numeric leaves whose key path looks amount-like.

    :param node: the current node, which may be a dict, a list, or a leaf value.
    :param key_hint: the nearest enclosing key name, which is what the token test runs against. List
        elements inherit the hint from the key that held the list.
    :param out: the accumulating set of amounts, mutated in place.
    :returns: None
    """
    if isinstance(node, dict):
        for k, v in node.items():
            _walk_amounts(v, k, out)
    elif isinstance(node, list):
        for v in node:
            _walk_amounts(v, key_hint, out)
    else:
        if any(t in key_hint.lower() for t in _AMOUNT_TOKENS):
            try:
                val = float(str(node).replace(",", ""))
                if val > 0:
                    out.add(val)
            except (TypeError, ValueError):
                # A non-numeric leaf under an amount-ish key, e.g. "N/A" or a currency word. Skipping
                # it is correct; raising here would fail the whole classification over a stray field.
                pass


def extract_candidate_amounts(item: ReconItem) -> list[float]:
    """The extracted amounts a ledger entry could plausibly settle.

    Both places an extraction can put a number are searched: the flat attribute bag and the per-
    section field maps. Only positive values survive, since a ledger amount is compared by absolute
    value and the direction comes from the entry type instead.

    :param item: the reconciliation item.
    :returns: the distinct amounts found under amount-like keys, sorted.
    """
    out: set = set()
    _walk_amounts(item.attributes.get("idp_attributes") or {}, "", out)
    for sec in item.attributes.get("idp_sections") or []:
        _walk_amounts(sec.get("fields") or {}, "", out)
    return sorted(out)


# Tokens in the document class that mean a prior cash movement is being reversed or withdrawn, which
# is a debit against the cash account. Anything naming a settlement or receipt instead — interest, a
# paydown, principal, a fee, a rate-set, a borrowing draw — is money arriving, so a credit.
#
# Worth being clear about what these lists are and are not. The class vocabulary belongs to the
# extraction service, and recon treats the class string as opaque everywhere else. These tokens are a
# deliberate derivation from it, not a copy of that external enumeration, which is why an unmatched
# class escalates instead of guessing a direction.
_DEBIT_CLASS_TOKENS = ("cancel", "withdraw", "reversal", "reverse")
_CREDIT_CLASS_TOKENS = (
    "interest",
    "paydown",
    "payment",
    "principal",
    "prepay",
    "repay",
    "fee",
    "rateset",
    "rate_set",
    "borrowing",
    "draw",
    "remittance",
    "wire",
)


def _borrower(item: ReconItem) -> Optional[str]:
    """The counterparty or account name from the extraction, matching the ledger's borrower column.

    :param item: the reconciliation item.
    :returns: the trimmed name, or None when the extraction did not produce one.
    """
    borrower = (item.attributes.get("idp_attributes") or {}).get("BorrowerName")
    return str(borrower).strip() if borrower else None


def _derive_entry_type(item: ReconItem) -> Optional[str]:
    """Derive the credit or debit direction from the document class.

    Documents carry no explicit entry-type field, so the direction has to be inferred from the class
    string by keyword. When the class is missing, or matches none of the known tokens, this returns
    None and the item escalates. That is the point: matching against a guessed direction would clear a
    reversal against a receipt of the same amount, which is a wrong answer that looks like a right one.

    :param item: the reconciliation item.
    :returns: ``"CREDIT"``, ``"DEBIT"``, or None when the direction cannot be derived.
    """
    idp_class = item.attributes.get("idp_class")
    if not idp_class:
        return None
    normalized = str(idp_class).lower()
    if any(token in normalized for token in _DEBIT_CLASS_TOKENS):
        return "DEBIT"
    if any(token in normalized for token in _CREDIT_CLASS_TOKENS):
        return "CREDIT"
    return None


def default_invoker(payload: dict) -> dict:
    """Invoke the ledger-query Lambda synchronously.

    This is the real transport, injected as a parameter everywhere it is used so tests can substitute
    a plain function instead of reaching for a live Lambda.

    :param payload: the query, e.g. ``{"borrower": ..., "limit": ...}``.
    :returns: the Lambda's response, shaped ``{"rows": [...], "count": n}``.
    """
    fn = os.environ["GL_QUERY_FUNCTION"]
    resp = boto3.client("lambda").invoke(FunctionName=fn, Payload=json.dumps(payload).encode())
    return json.loads(resp["Payload"].read())


# Why a deterministic ledger match did not happen. These travel to the agent as the item's
# ``tier1_escalation_reason``, so they are a contract with the agent's prompt, not log text.
#
# GL_AMBIGUOUS is the one that earns its keep. It says candidate rows were found and rejected for not
# being unique, which is a completely different investigation from "the ledger has nothing matching".
# Collapsing the two would send the agent looking for a missing entry that is actually sitting there
# twice.
GL_ZERO = "gl_zero"
GL_AMBIGUOUS = "gl_ambiguous"
GL_NO_BORROWER = "gl_no_borrower"
GL_NO_ENTRY_TYPE = "gl_no_entry_type"
GL_QUERY_FAILED = "gl_query_failed"


@dataclass(frozen=True)
class GlMatch:
    """The outcome of a deterministic ledger lookup: the single matched row, or why there wasn't one.

    Exactly one of ``row`` and ``reason`` is ever set. Both being None would mean the lookup neither
    succeeded nor explained itself, which no code path produces.

    ``match`` accompanies ``row`` and records the comparison that accepted it: the extracted amount,
    the ledger amount, the margin between them, the tolerance, the entry type and the borrower. The
    row alone cannot explain the match, because which of several extracted candidate amounts it
    settled is not recoverable from the row afterwards.
    """

    row: dict | None = None
    reason: str | None = None
    match: dict[str, str] | None = None


def gl_lookup(item: ReconItem, *, invoker: Callable[[dict], dict]) -> GlMatch:
    """Match an item against the ledger on borrower, entry type, and amount within tolerance.

    The query goes out by borrower, then two filters run over what comes back: the row's entry type
    has to equal the direction derived from the document class, and its amount has to sit within
    ``TOLERANCE`` of one of the extracted amounts. An auto-clear needs exactly one surviving row.
    Zero means no match. Two or more means ambiguous, and the agent decides.

    Every failure here is soft. A missing borrower, a direction that could not be derived, or a
    lookup error all produce a match with no row and a named reason, so the item escalates the way it
    would have anyway. None of them block the pipeline, which is deliberate: the ledger is an
    optimisation on top of the agent path, not a prerequisite for it.

    :param item: the reconciliation item.
    :param invoker: callable that runs the ledger query, injected so tests need no Lambda.
    :returns: the match, carrying either the single row or the reason there wasn't one.
    """
    borrower = _borrower(item)
    if not borrower:
        return GlMatch(reason=GL_NO_BORROWER)
    entry_type = _derive_entry_type(item)
    if not entry_type:
        return GlMatch(reason=GL_NO_ENTRY_TYPE)
    try:
        rows = invoker({"borrower": borrower}).get("rows", [])
        candidates = extract_candidate_amounts(item)
        matches = []
        for row in rows:
            if str(row.get("entry_type", "")).upper() != entry_type:
                continue
            try:
                amount = float(str(row.get("amount", "")).replace(",", ""))
            except (TypeError, ValueError):
                continue
            # Keep the closest accepting candidate alongside the row, not just the fact that one
            # existed. Which extracted amount the ledger row settled is the substance of the match,
            # and it cannot be recovered from the row later — the row does not know what it was
            # compared against.
            within = [c for c in candidates if abs(amount - c) <= TOLERANCE]
            if within:
                matched_candidate = min(within, key=lambda c: abs(amount - c))
                matches.append((row, amount, matched_candidate))
        # Deterministic only when the answer is unambiguous: exactly one row survived all three
        # filters. Anything else is a judgement call, and judgement calls belong to the agent.
        if len(matches) == 1:
            row, ledger_amount, extracted_amount = matches[0]
            return GlMatch(
                row=row,
                match={
                    "borrower": borrower,
                    "entry_type": entry_type,
                    "tolerance": str(TOLERANCE),
                    "extracted_amount": str(extracted_amount),
                    "ledger_amount": str(ledger_amount),
                    "difference": str(abs(ledger_amount - extracted_amount)),
                    "candidates_considered": str(len(candidates)),
                    "ledger_rows_returned": str(len(rows)),
                },
            )
        if len(matches) > 1:
            logger.info(
                "GL match ambiguous for %s (%d candidate rows) — escalating to agent",
                item.item_id,
                len(matches),
            )
            return GlMatch(reason=GL_AMBIGUOUS)
        return GlMatch(reason=GL_ZERO)
    except Exception as exc:  # noqa: BLE001 - see the docstring: a ledger issue must not block intake
        logger.warning("GL lookup failed for %s: %s", item.item_id, exc)
        return GlMatch(reason=GL_QUERY_FAILED)


def fetch_candidates(
    item: ReconItem, *, invoker: Callable[[dict], dict], limit: int = 5
) -> list[dict]:
    """Fetch near-miss ledger rows for the same borrower, as context for the agent.

    Called when no deterministic match was found. The agent gets real ledger rows to reason over
    rather than having to ask for them, which is the difference between an investigation that cites
    the ledger and one that speculates about it.

    Soft-fails to an empty list for the same reason the lookup does: missing context degrades the
    investigation, but a ledger outage should not stop items from being escalated.

    :param item: the reconciliation item.
    :param invoker: callable that runs the ledger query, injected so tests need no Lambda.
    :param limit: how many rows to ask for, and how many to keep if the query returns more.
    :returns: up to ``limit`` ledger rows, or an empty list.
    """
    borrower = (item.attributes.get("idp_attributes") or {}).get("BorrowerName")
    if not borrower:
        return []
    try:
        return invoker({"borrower": borrower, "limit": limit}).get("rows", [])[:limit]
    except Exception as exc:  # noqa: BLE001 - context is optional, escalation is not
        logger.warning("GL candidate fetch failed for %s: %s", item.item_id, exc)
        return []
