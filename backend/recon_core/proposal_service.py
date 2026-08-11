"""Shared proposal-service primitives used by BOTH agent backends.

The runtime container (Strands loop) and the harness worker previously carried duplicate
implementations of the ledger-reference derivation. This module is the single home for the
trust-relevant rule:

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
