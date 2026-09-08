import { describe, expect, it } from "vitest";

import { destinationFor, KB_UPLOAD_PREFIX } from "@/lib/uploadDestination";

/** When the submission happened. Fixed, so a sidecar's date attributes are assertable. */
const UPLOADED_AT = "2026-09-02T12:00:00Z";

describe("destinationFor", () => {
  it("puts an extraction file at the pipeline bucket root under its own name", () => {
    const d = destinationFor({
      route: "extraction",
      filename: "Borrowing_Notice.pdf",
      contentType: "application/pdf",
      uploadedAt: UPLOADED_AT,
      configVersion: "Recon-IDP",
    });
    expect(d.bucket).toBe("idp-input");
    expect(d.key).toBe("Borrowing_Notice.pdf");
    expect(d.metadata).toEqual({ "config-version": "Recon-IDP" });
    expect(d.sidecar).toBeNull();
  });

  it("puts a knowledge-base file under uploads/ with a sidecar beside it", () => {
    const d = destinationFor({
      route: "knowledge-base",
      filename: "settlement-query.pdf",
      contentType: "application/pdf",
      uploadedAt: UPLOADED_AT,
      docType: "email",
      breakClasses: ["fee_discrepancy"],
      skills: ["commitment_fee"],
      subject: "Fee query",
      sender: "ops@counterparty.test",
      recipients: ["recon@agent.test"],
      messageId: "<m@x.test>",
      receivedDate: "2026-09-02T09:15:00Z",
      hasAttachments: false,
    });
    expect(d.bucket).toBe("recon-assets");
    expect(d.key).toBe(`${KB_UPLOAD_PREFIX}settlement-query.pdf`);
    expect(d.sidecar?.key).toBe(
      `${KB_UPLOAD_PREFIX}settlement-query.pdf.metadata.json`,
    );
    // The sidecar is a sibling of the object, suffixed. The connector finds it by that
    // convention; a sidecar anywhere else is simply not read, and the document indexes with
    // no attributes at all -- which no error reports.
    expect(d.metadata).toEqual({});
  });

  it("carries the break classes, skills and recipients through under their sidecar names", () => {
    // This is the assertion that catches a rename. `DestinationRequest` is named after form fields
    // (`breakClasses`, `skills`, `recipients`) and `SidecarInput` after sidecar attributes
    // (`breakClass`, `skills`, `receiver`). A mismatched key is not a type error -- the field is
    // optional on both sides -- so it drops the attribute, and the only symptom is a document that
    // no filtered retrieval ever returns.
    const d = destinationFor({
      route: "knowledge-base",
      filename: "guidance.pdf",
      contentType: "application/pdf",
      uploadedAt: UPLOADED_AT,
      docType: "email",
      breakClasses: ["timing"],
      skills: ["consult-guidance"],
      recipients: ["recon@agent.test"],
      subject: "Timing guidance",
    });
    const attrs = JSON.parse(d.sidecar!.body).metadataAttributes;
    expect(attrs.break_class.value.stringListValue).toEqual(["timing"]);
    expect(attrs.skill.value.stringListValue).toEqual(["consult-guidance"]);
    expect(attrs.receiver.value.stringListValue).toEqual(["recon@agent.test"]);
  });

  it("dates a knowledge-base file with no received date by when it was uploaded", () => {
    // A plain PDF an operator drops in is not an email and has no received date. The sidecar's
    // received_date and effective_date are NUMBER attributes the corpus filters on, so there is no
    // "absent" available: an empty string would reach yyyymmdd("") and throw, failing the whole
    // request for every non-email knowledge-base upload.
    const d = destinationFor({
      route: "knowledge-base",
      filename: "desk-note.pdf",
      contentType: "application/pdf",
      uploadedAt: UPLOADED_AT,
      docType: "email",
    });
    const attrs = JSON.parse(d.sidecar!.body).metadataAttributes;
    expect(attrs.received_date.value.numberValue).toBe(20260902);
    expect(attrs.effective_date.value.numberValue).toBe(20260902);
  });

  it("refuses a knowledge-base file with no doc type", () => {
    expect(() =>
      destinationFor({
        route: "knowledge-base",
        filename: "x.pdf",
        contentType: "application/pdf",
        uploadedAt: UPLOADED_AT,
      }),
    ).toThrow(/doc type/i);
  });

  it("refuses an extraction file with no config version", () => {
    // An unpinned object does not error -- the pipeline resolves whichever configuration is
    // active at that moment. That is exactly the silent behaviour the audit row exists to
    // catch, so the route refuses to create it in the first place.
    expect(() =>
      destinationFor({
        route: "extraction",
        filename: "x.pdf",
        contentType: "application/pdf",
        uploadedAt: UPLOADED_AT,
      }),
    ).toThrow(/config version/i);
  });

  it("never lets a knowledge-base key escape the uploads prefix", () => {
    // sanitizeFilename already throws on a path separator. This asserts the invariant at the
    // destination layer too, because the consequence of a miss here is that an upload
    // overwrites a Terraform-managed seed object and the next apply silently reverts it.
    const d = destinationFor({
      route: "knowledge-base",
      filename: "notice.pdf",
      contentType: "application/pdf",
      uploadedAt: UPLOADED_AT,
      docType: "email",
    });
    expect(d.key.startsWith(KB_UPLOAD_PREFIX)).toBe(true);
    expect(d.key).not.toContain("..");
  });
});
