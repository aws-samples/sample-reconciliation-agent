/**
 * Tests for the workflow-type validator.
 *
 * The rule under test is a mutual exclusion between a workflow type's route and the fields that only
 * belong to one route. It is worth testing carefully because both violations are invisible
 * downstream: an extraction with no version pinned extracts against whatever is active, and a
 * knowledge-base facet the agent does not filter on retrieves nothing and reports success.
 */
import { describe, it, expect } from "vitest";
import { workflowTypeRejectionReason } from "@/lib/workflowTypes";

/** A valid extraction row, so each test can change exactly the field it is about. */
const extraction = {
  workflow_type_id: "unapplied-cash-notice",
  display_name: "Unapplied cash notice",
  route: "extraction",
  idp_config_version: "cash-notice-v3",
};

/** A valid knowledge-base row, same purpose. */
const knowledgeBase = {
  workflow_type_id: "counterparty-guidance",
  display_name: "Counterparty guidance",
  route: "knowledge-base",
  kb_doc_type: "email",
};

describe("workflowTypeRejectionReason", () => {
  it("accepts a coherent extraction row", () => {
    expect(workflowTypeRejectionReason(extraction)).toBeNull();
  });

  it("accepts a coherent knowledge-base row", () => {
    expect(workflowTypeRejectionReason(knowledgeBase)).toBeNull();
  });

  it("requires a config version on an extraction route", () => {
    const reason = workflowTypeRejectionReason({
      ...extraction,
      idp_config_version: "",
    });
    // The message has to say more than "required", because the consequence is not an error the
    // admin will ever see: the upload succeeds against whichever configuration is active.
    expect(reason).toMatch(/idp_config_version/);
    expect(reason).toMatch(/active/);
  });

  it("treats a whitespace-only config version as absent", () => {
    expect(
      workflowTypeRejectionReason({
        ...extraction,
        idp_config_version: "   ",
      }),
    ).toMatch(/idp_config_version/);
  });

  it("forbids a config version on a knowledge-base route", () => {
    // The reverse direction matters as much as the forward one. A version pinned to a document that
    // is never extracted describes a step it does not take, and reading the row later gives the
    // wrong answer about where the document went.
    expect(
      workflowTypeRejectionReason({
        ...knowledgeBase,
        idp_config_version: "cash-notice-v3",
      }),
    ).toMatch(/must not pin idp_config_version/);
  });

  it("forbids a knowledge-base facet on an extraction route", () => {
    expect(
      workflowTypeRejectionReason({ ...extraction, kb_doc_type: "email" }),
    ).toMatch(/kb_doc_type does not apply/);
  });

  it("requires a knowledge-base facet on a knowledge-base route", () => {
    expect(
      workflowTypeRejectionReason({ ...knowledgeBase, kb_doc_type: "" }),
    ).toMatch(/needs kb_doc_type/);
  });

  it("accepts email_attachment as a knowledge-base facet", () => {
    expect(
      workflowTypeRejectionReason({
        ...knowledgeBase,
        kb_doc_type: "email_attachment",
      }),
    ).toBeNull();
  });

  it("rejects a facet outside the allowlist", () => {
    const reason = workflowTypeRejectionReason({
      ...knowledgeBase,
      kb_doc_type: "invoice",
    });
    expect(reason).toMatch(/kb_doc_type must be one of/);
    expect(reason).toMatch(/never retrieve/);
  });

  it("rejects playbook, which is seeded rather than uploaded", () => {
    // The agent's own filter accepts "playbook", so this is narrower on purpose: a playbook is
    // written by the reconciliation team and seeded with the corpus, not something an operator
    // uploads through this picker.
    expect(
      workflowTypeRejectionReason({
        ...knowledgeBase,
        kb_doc_type: "playbook",
      }),
    ).toMatch(/kb_doc_type must be one of/);
  });

  it("rejects an unrecognised route rather than defaulting to either", () => {
    expect(
      workflowTypeRejectionReason({ ...extraction, route: "ingest" }),
    ).toMatch(/route must be one of/);
  });

  it("rejects a missing route rather than inferring one from the other fields", () => {
    // A row carrying idp_config_version looks like an extraction, and inferring that would be the
    // convenient reading. It is also the one that lets a knowledge-base document be extracted
    // because someone left a stale version in the form.
    const reason = workflowTypeRejectionReason({
      workflow_type_id: "x",
      display_name: "X",
      idp_config_version: "cash-notice-v3",
    });
    expect(reason).toMatch(/route is required/);
  });

  it("requires an id and a display name", () => {
    expect(
      workflowTypeRejectionReason({ ...extraction, workflow_type_id: "" }),
    ).toMatch(/workflow_type_id/);
    expect(
      workflowTypeRejectionReason({ ...extraction, display_name: "" }),
    ).toMatch(/display_name/);
  });

  it("ignores non-string values instead of coercing them", () => {
    // A JSON body can carry anything. `route: 3` must be a rejection, not String(3).
    expect(workflowTypeRejectionReason({ ...extraction, route: 3 })).toMatch(
      /route is required/,
    );
  });
});
