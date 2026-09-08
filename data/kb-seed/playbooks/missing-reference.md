# Playbook — Missing reference

Conventions for a **missing reference** break. Which skill recovers an identifier is already routed by
the classification; this is what the recovery is worth once it succeeds.

**A recovered identifier is evidence, not a match.** Finding a facility id in correspondence tells you
what the counterparty called the asset. It does not establish that the two sides refer to the same
facility unless a governed crosswalk links the two namespaces. Where no crosswalk entry exists, asset
identity remains **unavailable** — an absence of proof rather than a mismatch.

**Where identifiers go missing.** Novations are the usual cause: a facility that changed agent carries
the new agent's own identifier and often no LoanX id at all until one is reissued. The notice will
usually say so in a comment. That comment is the evidence that the omission is expected rather than an
extraction failure.

**Do not carry an identifier across items.** An identifier recovered for one item is not authority for
another item on the same facility. Each item is corroborated on its own evidence.
