"""Tier-1 deterministic general-ledger match.

For IDP-sourced items (no sides), the deterministic tier looks the document up in the mocked
general ledger (the gl-query Lambda -> Athena over S3) by the *economic identity* of the cash
item: the **borrower / counterparty** (account name), an **amount** within tolerance, and the
**entry type** (CREDIT/DEBIT direction). It never keys on the document filename/reference — a
real ledger's ``reference`` column is a wire/transaction code, not an uploaded file name.

An item auto-clears deterministically only when **exactly one** GL row matches all three
attributes — no LLM involved. Zero matches, an ambiguous >1 match, or any missing input all
escalate to the agent (with the GL rows attached as ``gl_candidates`` context).
"""

import json
import logging
import os
from typing import Callable, Optional

import boto3

from backend.recon_core.schema import ReconItem

logger = logging.getLogger(__name__)

# Absolute tolerance for an amount to count as a deterministic match (same as the engine's
# cash-rule default).
TOLERANCE = 0.05

# Only leaves under keys containing one of these tokens count as candidate amounts.
_AMOUNT_TOKENS = ("amount", "payment", "share", "total", "principal", "interest")


def _walk_amounts(node, key_hint: str, out: set) -> None:
    """Recursively collect numeric leaves whose key path looks amount-like."""
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
                pass  # non-numeric leaf under an amount-ish key — ignore


def extract_candidate_amounts(item: ReconItem) -> list[float]:
    """Amounts extracted by IDP that a GL entry could settle (from idp_* attributes).

    :returns: distinct positive floats found under amount-like keys.
    """
    out: set = set()
    _walk_amounts(item.attributes.get("idp_attributes") or {}, "", out)
    for sec in item.attributes.get("idp_sections") or []:
        _walk_amounts(sec.get("fields") or {}, "", out)
    return sorted(out)


# Tokens in the (opaque, IDP-owned) document class that indicate a reversal/withdrawal of a
# prior cash movement — modelled as a DEBIT against the cash account. Everything else that names
# a settlement/receipt (interest, paydown, principal, fee, rate-set, borrowing draw) is a cash
# receipt — a CREDIT. The class vocabulary lives in the IDP service; this is a deliberate,
# documented derivation (recon otherwise treats ``idp_class`` as opaque), not a hard-coded
# enumeration of that external list.
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
    """The counterparty / account name extracted by IDP (GL ``borrower`` column)."""
    borrower = (item.attributes.get("idp_attributes") or {}).get("BorrowerName")
    return str(borrower).strip() if borrower else None


def _derive_entry_type(item: ReconItem) -> Optional[str]:
    """Derive the CREDIT/DEBIT direction from the IDP document class.

    Documents carry no explicit entry-type field, so the direction is inferred from the opaque
    ``idp_class`` string by keyword. Returns ``None`` when the class is absent or matches no
    known token, in which case the item escalates to the agent rather than deterministically
    matching against the wrong direction.

    :param item: the reconciliation item.
    :returns: ``"CREDIT"``, ``"DEBIT"``, or ``None`` when underivable.
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
    """Invoke the gl-query Lambda synchronously; returns its {rows, count} response."""
    fn = os.environ["GL_QUERY_FUNCTION"]
    resp = boto3.client("lambda").invoke(
        FunctionName=fn, Payload=json.dumps(payload).encode()
    )
    return json.loads(resp["Payload"].read())


def gl_lookup(item: ReconItem, *, invoker: Callable[[dict], dict]) -> Optional[dict]:
    """Deterministic GL match on borrower (account name) + entry type + amount within tolerance.

    Queries the GL by borrower, then keeps rows whose ``entry_type`` equals the direction
    derived from the document class AND whose ``amount`` is within ``TOLERANCE`` of an
    IDP-extracted amount. A deterministic auto-clear requires **exactly one** surviving row:
    zero → no match; two or more → ambiguous, escalate to the agent.

    Fail-soft: a missing borrower, an underivable entry type, or any lookup error returns None
    (the item escalates to the agent as before), never blocking the pipeline.

    :param item: the reconciliation item.
    :param invoker: callable running the gl-query Lambda (injected in tests).
    :returns: the single matched GL row, or None when absent/ambiguous.
    """
    borrower = _borrower(item)
    entry_type = _derive_entry_type(item)
    if not borrower or not entry_type:
        return None
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
            if any(abs(amount - c) <= TOLERANCE for c in candidates):
                matches.append(row)
        # Deterministic only when unambiguous: exactly one GL row survives all three filters.
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            logger.info(
                "GL match ambiguous for %s (%d candidate rows) — escalating to agent",
                item.item_id,
                len(matches),
            )
        return None
    except Exception as exc:  # noqa: BLE001 - never block the pipeline on GL issues
        logger.warning("GL lookup failed for %s: %s", item.item_id, exc)
        return None


def fetch_candidates(item: ReconItem, *, invoker: Callable[[dict], dict], limit: int = 5) -> list[dict]:
    """Context rows for the agent when no deterministic match exists (by borrower). Fail-soft."""
    borrower = (item.attributes.get("idp_attributes") or {}).get("BorrowerName")
    if not borrower:
        return []
    try:
        return invoker({"borrower": borrower, "limit": limit}).get("rows", [])[:limit]
    except Exception as exc:  # noqa: BLE001
        logger.warning("GL candidate fetch failed for %s: %s", item.item_id, exc)
        return []
