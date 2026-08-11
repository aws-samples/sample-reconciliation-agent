---
name: document-cross-reference
description: Retrieve and compare fields from a source document to confirm or refute a candidate match with records in the ledger.
tools: [document-extraction___IDPTools___get_results, general-ledger___search_ledger]
---

When an item's attributes are incomplete, retrieve the underlying document's extracted fields
from IDP via the **document-extraction** MCP tool. Never read IDP's S3 output or AppSync
directly — the only channel to IDP is this MCP tool.

1. Read the IDP backlink from the item's `source_refs`: the `idp:documentId=<id>` entry (and
   `idp:section=<section_id>:<uri>` if you need a specific section). The `<id>` value is the
   document id you pass to `get_results` below.
2. Call the document-extraction MCP tool with the **`document_id`** parameter:
   `document-extraction___IDPTools___get_results(document_id=<id>)` to fetch the full
   `inference_result` fields and their `explainability_info` / `confidence_threshold_alerts`
   confidence. **Always use `document_id` for a single document — never `batch_id`.** `batch_id`
   routes to the multi-document batch path (which fails for a single doc), and the parameter is
   `document_id` (snake_case), not `documentId`.
3. If the item has **no** `idp:` backlink (e.g. it arrived via the structured API), use the
   MCP `search` tool (natural-language query by amount / value date / counterparty) to locate
   the corroborating document, then `document-extraction___IDPTools___get_results(document_id=<id>)`
   on the best match.
4. Compare the extracted values (effective date, amount, identifier, borrower) against both
   reconciliation sides.

Always conclude with: (1) a one-paragraph **reasoning** of which extracted fields corroborate
or conflict with the sides, (2) a **confidence** score in [0,1] (dampened by IDP's own
extraction confidence when low), and (3) the **evidence** list (the extracted field values you
used). These populate the case's ReasoningStep.
