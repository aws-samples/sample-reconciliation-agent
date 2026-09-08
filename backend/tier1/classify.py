"""Deterministic break classification: plain Python, no LLM, no I/O.

This runs on the escalation path in the stream consumer, once the deterministic matchers have given
up on an item. It asks a different question from the reconciliation engine. The engine asks whether
two sides agree. This asks what kind of break we are looking at.

The answer is a skill name, stamped onto the item as ``tier1_break_type``, and Tier-2 treats it
strictly as a hint. The agent still runs its own self-consistency classification and still loads the
whole skill library, so a wrong or absent hint costs accuracy at worst, never correctness.

Deliberately NOT catalog-driven. Reading the skill catalog from S3 and evaluating a predicate DSL out
of each skill's frontmatter is the obvious way to make this configurable, and it is the wrong one for
two reasons worth knowing before anyone builds it. Tier-1 runs on a stream shard and must not take a
network dependency on a catalog the UI can edit. And any tool exclusions such rules computed would be
re-checked inside the agent regardless, so they would never be the guarantee they look like.

Everything here has to be safe on a DynamoDB Stream shard: pure functions, no S3, no cache, no
clock. An exception on this path is worse than a failed classification, because it blocks the shard
until the record ages out.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from backend.recon_core.schema import ReconItem

logger = logging.getLogger(__name__)

# Value types a rule is allowed to compare. A dict or list value is structure, not a field.
#
# Decimal is load-bearing here, not defensive. Items arrive from the stream consumer, which builds
# them through boto3's TypeDeserializer, and that renders every DynamoDB `N` attribute as a Decimal.
# Drop Decimal from this tuple and every numeric field on the item quietly vanishes from the record:
# amounts, tolerances, anything numeric that intake wrote. A rule naming one could then never fire,
# and the symptom is indistinguishable from "no rule matched".
#
# Extraction confidence deliberately is not part of this. Document notices live in their own table
# and are read through a search tool, so no break-type rule can key off an extraction artefact.
# Evidence quality gets scored on its own, later, by the confidence module.
_SCALARS = (str, int, float, bool, Decimal)


@dataclass(frozen=True)
class BreakRecord:
    """The flat field namespace the break-type rules are evaluated against.

    ``dropped`` names the fields two sides disagreed about. A conflicting field is omitted entirely
    rather than resolved by side order: picking side 0 would let the order the feed happened to
    deliver the sides in decide a classification. The names are carried for logging only. No current
    rule reads a side field, so stamping them onto the item would imply a causal link that is not
    there.
    """

    fields: dict
    dropped: tuple[str, ...] = ()


def break_record(item: ReconItem) -> BreakRecord:
    """Flatten an item into the field namespace the break-type rules address.

    Precedence runs lowest to highest: the item's own attributes (derived and enriched passthrough),
    then the sides' attributes (the authoritative upstream break columns), then the reserved fields
    set at the end, which nothing may shadow.

    Side attributes are flattened without a prefix. The upstream break record already namespaces its
    own columns, in the ``Party1LocalMV`` / ``Party2LocalMV`` style, so a ``bank.amount`` prefix here
    would buy nothing and would make every rule depend on which side landed first.

    :param item: the reconciliation item.
    :returns: the flattened record plus the names of any conflict-dropped fields.
    """
    fields = {k: v for k, v in (item.attributes or {}).items() if isinstance(v, _SCALARS)}
    seen: dict[str, object] = {}
    dropped: set[str] = set()
    for side in item.sides:
        for k, v in (side.attributes or {}).items():
            if k in seen and seen[k] != v:
                dropped.add(k)
            else:
                seen[k] = v
    for k, v in seen.items():
        if k in dropped:
            fields.pop(k, None)
        else:
            fields[k] = v
    fields.update(
        item_id=item.item_id, domain=item.domain, tier=item.tier, side_count=len(item.sides)
    )
    if dropped:
        logger.info(
            "break_record dropped conflicting field(s) %s for %s", sorted(dropped), item.item_id
        )
    return BreakRecord(fields=fields, dropped=tuple(sorted(dropped)))


# The break-type rule table: a class name paired with a predicate over the flattened break record.
#
# Every name on the left has to be a skill name in the shipped catalog. Nothing checks that at
# runtime; the build fails instead, and the agent drops a class it cannot find in the live catalog
# rather than acting on it.
#
# Each predicate must be total over the record. Use ``.get``, never ``[]``, and never assume a type.
# A rule that raises does not produce "no classification" — it blocks the stream shard.
#
# Rules are evaluated first-match-wins. The two below partition the input on side count, so order
# cannot matter yet, and a test holds that line. Add an overlapping rule and the tie-break belongs
# in this table, next to the rules it breaks, not somewhere downstream.
#
# The vocabulary is small because Tier-1's inputs are small: the item's shape (side count, domain)
# and whatever upstream dropped in the attribute bag. Richer signals like an entry type or a
# categorised break reason can become rules here once a real feed actually supplies them.
BREAK_TYPE_RULES: tuple[tuple[str, Callable[[dict], bool]], ...] = (
    # Two sides that survived the tolerance matcher, so the amounts, dates or references really do
    # disagree. The work is a field-by-field comparison of the two records.
    ("record-match-review", lambda record: record.get("side_count") == 2),
    # No sides at all: an extracted document with no counterpart in the feed. The question is what
    # the general ledger already says about it.
    ("ledger-status-resolution", lambda record: record.get("side_count") == 0),
)


def classify_break(record: dict) -> str | None:
    """Resolve the break type from the flattened record, or None when no rule matched.

    :param record: the flattened break record, meaning ``BreakRecord.fields``.
    :returns: the matching class, which is a skill name, or None to escalate unclassified. None is
        not a failure — it is the behaviour that predates this module, where Tier-2 classifies from
        scratch.
    """
    for name, predicate in BREAK_TYPE_RULES:
        if predicate(record):
            return name
    return None
