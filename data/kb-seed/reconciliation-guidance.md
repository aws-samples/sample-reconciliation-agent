# Reconciliation Guidance & Playbooks (recon KB seed)

Starter guidance the agent retrieves via the recon Knowledge Base (S3-sourced) to decide how to
investigate and resolve a break. Distinct from IDP — document specifics come from IDP MCP; this
is _how to reconcile_. Extend with your own playbooks and SharePoint-exported content.

## Break types and default handling

- **Timing difference** — both sides agree on amount but differ on value/settlement date by a
  small number of business days. Playbook: confirm the offset is within the expected settlement
  window; if so, propose "no action required — timing", else escalate. Consult SharePoint for
  the counterparty's standard settlement calendar via the Microsoft Graph tool if unsure.
- **Amount within tolerance** — amounts differ by a small rounding / FX-conversion amount inside
  the configured tolerance. Playbook: auto-match; record the tolerance applied and the FX rate
  source.
- **Aggregation (multi-facility wire)** — one incoming wire settles several facilities/contracts
  (e.g. interest + principal, or multiple facilities on one payment). Playbook: group the ledger
  records whose sum matches the wire; document each component and the aggregation basis. Pull the
  agent notice via the document-extraction (IDP) tool to confirm the component breakdown.
- **Missing reference** — one side lacks an identifier (CUSIP, LoanXID, facility) present on the
  other. Playbook: recover the reference via the document-cross-reference skill (IDP) or the
  correspondence-search skill (Graph mailbox), then match.
- **Unknown / unclassified** — no confident classification. Playbook: gather available context,
  summarize what is known vs. missing, and escalate to a human analyst rather than proposing a
  resolution.

## When to auto-resolve vs. escalate

Auto-resolve only for deterministic-eligible classes at high confidence (see each SKILL.md
`confidence_threshold`). Anything touching a system of record, an outbound counterparty
communication, or below threshold is propose-only → human approval. Never override the internal
ledger; all actions are audited.

## Using guidance vs. live sources

- **This KB (retrieve_and_generate):** methodology, playbooks, precedent — the "how".
- **Microsoft Graph tool:** live SharePoint/Outlook/OneDrive — a specific email, a settlement
  calendar, a counterparty contact.
- **IDP MCP (document-extraction):** the extracted fields of a specific processed notice.
