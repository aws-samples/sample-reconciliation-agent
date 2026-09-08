/**
 * The one rule that keeps a workflow type coherent: a document's destination is never ambiguous.
 *
 * A workflow type says what an operator may upload and where that upload goes -- either it is
 * EXTRACTED into a structured notice against a pinned extraction configuration, or it is INGESTED
 * into the knowledge base as guidance. Those are different destinations, and the fields that belong
 * to one are meaningless on the other. This module rejects rows that claim both or neither.
 *
 * Why it is checked here rather than by the database: DynamoDB declares only the partition key, so
 * nothing at the storage layer would notice a row with a route of "extraction" and no version
 * pinned. And that particular row is the dangerous one. An upload with no extraction version pinned
 * does not fail downstream -- the document pipeline resolves whichever configuration happens to be
 * active at that moment -- so the result is a wrong extraction with no error anywhere to explain it.
 * The route is therefore an explicit stored value rather than something inferred from a blank field,
 * and this is the only place that inference is ruled out.
 *
 * Why TypeScript and only TypeScript: the sole writer is the Config tab's route handler, which is
 * TypeScript and cannot call a Python function. Shipping a Python twin as well would put the tested
 * copy in dead code and the enforcing copy under no test -- which reads as covered on a test report
 * and is not. When a Python writer appears, it gets a twin AND an assertion that the two agree.
 */

/** The two destinations an upload can have. Anything else is a rejection, not a default. */
export const WORKFLOW_ROUTES = ["extraction", "knowledge-base"] as const;

/**
 * Knowledge-base facets an uploaded document may be stamped with.
 *
 * This is deliberately NARROWER than the agent's own filter list, which also accepts "playbook".
 * A playbook is written by the reconciliation team and seeded with the knowledge base; it is not
 * something a counterparty sends and not something this picker should be able to mint.
 *
 * The list is duplicated from GUIDANCE_DOC_TYPES in agent-blueprint/recon-agent/strands_investigator.py
 * and that duplication has a cost worth stating plainly: a facet accepted here but absent from the
 * agent's filter produces a document the agent can never retrieve, with nothing anywhere saying why.
 * If you add a value, add it on both sides in the same change.
 */
export const KB_DOC_TYPES = ["email", "email_attachment"] as const;

/**
 * Reject a workflow-type row whose route and its route-specific fields disagree.
 *
 * @param row - the candidate row, exactly as the route handler received it (untrusted, unparsed).
 * @returns null when the row is valid, otherwise the reason to return in a 400. The reason is
 *   written to be shown to the admin who typed it, so it names the field and what to do about it.
 */
export function workflowTypeRejectionReason(
  row: Record<string, unknown>,
): string | null {
  const str = (key: string): string =>
    typeof row[key] === "string" ? (row[key] as string).trim() : "";

  const id = str("workflow_type_id");
  if (!id) {
    return "workflow_type_id is required";
  }
  if (!str("display_name")) {
    return "display_name is required — it is what the upload picker shows";
  }

  const route = str("route");
  if (!route) {
    // Not defaulted to either destination. Guessing here is how a knowledge-base document becomes
    // an extraction, or the reverse, without anybody choosing it.
    return `route is required and must be one of ${WORKFLOW_ROUTES.join(", ")}`;
  }
  if (!(WORKFLOW_ROUTES as readonly string[]).includes(route)) {
    return `route must be one of ${WORKFLOW_ROUTES.join(", ")}, got "${route}"`;
  }

  const version = str("idp_config_version");
  const docType = str("kb_doc_type");

  if (route === "extraction") {
    if (!version) {
      return "an extraction route needs idp_config_version — leaving it blank does not fail the upload, it extracts against whichever configuration happens to be active";
    }
    if (docType) {
      return "kb_doc_type does not apply to an extraction route; it only means something to the knowledge base";
    }
    return null;
  }

  // route === "knowledge-base"
  if (version) {
    return "a knowledge-base route must not pin idp_config_version — the document is not extracted, so the version would describe a step it never reaches";
  }
  if (!docType) {
    return `a knowledge-base route needs kb_doc_type (${KB_DOC_TYPES.join(" or ")})`;
  }
  if (!(KB_DOC_TYPES as readonly string[]).includes(docType)) {
    return `kb_doc_type must be one of ${KB_DOC_TYPES.join(", ")}, got "${docType}" — a facet the agent does not filter on is a document it can never retrieve`;
  }
  return null;
}
