# Reconciliation Resolution Patterns (seed corpus)

This seed document grounds the Knowledge Base so day-one "how was a similar item resolved
before?" lookups return useful context. Replace/extend with your own resolution history.

## Timing friction

A break where both sides agree on amount but differ on value/settlement date by a small
number of business days. Common resolution: no action required once the later side settles;
confirm the offset is within the expected settlement window.

## Amount-within-tolerance

Amounts differ by a small rounding or FX-conversion amount within the configured tolerance.
Common resolution: auto-match; record the tolerance applied.

## Aggregation

Multiple records on one side sum to a single record on the other (e.g. interest + principal
booked separately vs. one combined receipt). Common resolution: match the group; document the
components.

## Missing reference

One side lacks an identifier present on the other. Common resolution: cross-reference source
documents or the transaction log to recover the reference, then match.

## Unknown / escalate

No confident classification. Gather available context and escalate to a human analyst rather
than proposing a resolution.
