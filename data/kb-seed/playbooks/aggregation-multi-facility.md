# Playbook — Aggregation (multi-facility wire)

Conventions for an **aggregation** break. The component-to-component and sum-to-total comparison is in
`record-match-review`; this is what to do when the components do not obviously line up.

**The breakdown is the agent's to state, never yours to infer.** Where a wire covers several facilities,
the consolidated advice carries the component list. Retrieve it and compare against it. Reconstructing a
plausible split from the ledger side and matching against your own reconstruction produces a confident
answer with no evidence behind it.

**One wire, several funds.** A single payment can cover several portfolios on the same facility. The
components then differ by fund, not by facility, and matching on facility alone will appear to succeed
while attributing cash to the wrong fund.

**Residuals on aggregated wires.** See the tolerance playbook: a residual that grows with the component
count is rounding at the allocation level, and one that does not is a missing or extra component.
