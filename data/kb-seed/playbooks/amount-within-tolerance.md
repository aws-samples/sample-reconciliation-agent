# Playbook — Amount within tolerance

Conventions for a **tolerance** break. The comparison procedure itself lives in
`record-match-review`; this is what that procedure cannot know.

**Recording an FX-driven difference.** When the residual is explained by conversion rather than by a
real discrepancy, the evidence must name the rate source and the rate date, not just the residual. A
tolerance applied without a stated source cannot be re-checked later, which is the whole reason an
analyst asks about one.

**Rounding conventions seen in practice.** Agent banks round lender allocations at the facility level,
not the loan level, so a residual of a few cents on a multi-component wire is expected and does not
indicate a misallocation. A residual that scales with the number of components is the signal worth
investigating — one that stays constant is rounding.

**On autonomy:** nothing in this document authorises resolving a break without a human. Whether an item
can be auto-resolved is decided by the evidence-completeness score and the server-side gates, never by
how explicable a difference looks.
