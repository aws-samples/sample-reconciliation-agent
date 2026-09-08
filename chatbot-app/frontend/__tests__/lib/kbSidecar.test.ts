import { describe, expect, it } from "vitest";
import { buildSidecar, yyyymmdd } from "@/lib/kbSidecar";

const BASE = {
  docType: "email" as const,
  messageId: "MSG-20260902-ABC123",
  subject: "Unapplied cash — reference 4471",
  sender: "ops@counterparty.example.com",
  receiver: ["recon@example.com"],
  receivedDate: "2026-09-02T10:00:00Z",
};

describe("buildSidecar", () => {
  it("wraps every attribute in the value/includeForEmbedding envelope", () => {
    const attrs = buildSidecar(BASE).metadataAttributes;
    expect(attrs.doc_type).toEqual({
      value: { type: "STRING", stringValue: "email" },
      includeForEmbedding: false,
    });
  });

  it("embeds the subject and the break class, and nothing else", () => {
    const attrs = buildSidecar({
      ...BASE,
      breakClass: ["timing"],
      skills: ["consult-guidance"],
    }).metadataAttributes;
    const embedded = Object.entries(attrs)
      .filter(([, a]) => a.includeForEmbedding)
      .map(([k]) => k)
      .sort();
    // `skill` is present but NOT embedded, which is what the seeded corpus does. Embedding a tool
    // name would drag unrelated documents toward any question that happens to mention that tool.
    expect(embedded).toEqual(["break_class", "subject"]);
  });

  it("writes skill as a STRING_LIST — consult-guidance filters on it", () => {
    const attrs = buildSidecar({
      ...BASE,
      skills: ["consult-guidance", "reconcile-cash"],
    }).metadataAttributes;
    expect(attrs.skill).toEqual({
      value: {
        type: "STRING_LIST",
        stringListValue: ["consult-guidance", "reconcile-cash"],
      },
      includeForEmbedding: false,
    });
    // Omitted rather than empty when nothing was picked. An attribute present-and-empty matches a
    // filter for the empty list; absent matches nothing, which is the honest answer.
    expect(buildSidecar(BASE).metadataAttributes.skill).toBeUndefined();
  });

  it("renders dates as YYYYMMDD numbers, because that is what the corpus filters on", () => {
    const attrs = buildSidecar(BASE).metadataAttributes;
    expect(attrs.received_date.value).toEqual({
      type: "NUMBER",
      numberValue: 20260902,
    });
    expect(attrs.effective_date.value).toEqual({
      type: "NUMBER",
      numberValue: 20260902,
    });
  });

  it("writes has_attachments as a STRING — the managed KB drops BOOLEAN attributes", () => {
    const attrs = buildSidecar({
      ...BASE,
      hasAttachments: true,
    }).metadataAttributes;
    expect(attrs.has_attachments.value).toEqual({
      type: "STRING",
      stringValue: "true",
    });
  });

  it("never emits a BOOLEAN anywhere", () => {
    const json = JSON.stringify(
      buildSidecar({ ...BASE, hasAttachments: false, breakClass: ["timing"] }),
    );
    expect(json).not.toContain("BOOLEAN");
    expect(json).not.toContain("booleanValue");
  });

  it("carries attachment_format on an attachment and has_attachments on a body", () => {
    const att = buildSidecar({
      ...BASE,
      docType: "email_attachment",
      attachmentFormat: "pdf",
    }).metadataAttributes;
    expect(att.attachment_format.value).toEqual({
      type: "STRING",
      stringValue: "pdf",
    });
    expect(att.has_attachments).toBeUndefined();
    const body = buildSidecar({
      ...BASE,
      hasAttachments: false,
    }).metadataAttributes;
    expect(body.attachment_format).toBeUndefined();
  });

  it("refuses an attachment with no format — a filter would never match it", () => {
    expect(() =>
      buildSidecar({ ...BASE, docType: "email_attachment" }),
    ).toThrow(/attachment_format/);
  });

  it("omits optional attributes rather than writing an empty string", () => {
    const attrs = buildSidecar({ ...BASE, sender: "" }).metadataAttributes;
    expect(attrs.sender).toBeUndefined();
  });
});

describe("yyyymmdd", () => {
  it("reads the UTC date, not the local one", () => {
    expect(yyyymmdd("2026-01-01T00:30:00Z")).toBe(20260101);
  });

  it("throws on something that is not a date", () => {
    expect(() => yyyymmdd("last Tuesday")).toThrow();
  });
});
