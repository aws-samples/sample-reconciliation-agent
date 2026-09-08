import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  contentTypeFor,
  MAX_OBJECT_BYTES,
  sanitizeFilename,
  uploadRejectionReason,
} from "@/lib/uploadPolicy";

describe("uploadRejectionReason", () => {
  it("accepts the four types the pipeline can read", () => {
    for (const name of ["a.pdf", "a.docx", "a.msg", "a.eml"]) {
      expect(uploadRejectionReason({ filename: name, bytes: 10 })).toBeNull();
    }
  });

  it("refuses a type the pipeline cannot read, naming it", () => {
    const reason = uploadRejectionReason({ filename: "sheet.xlsx", bytes: 10 });
    expect(reason).toContain(".xlsx");
  });

  it("matches the extension case-insensitively", () => {
    expect(uploadRejectionReason({ filename: "A.PDF", bytes: 10 })).toBeNull();
  });

  it("refuses an empty object", () => {
    expect(uploadRejectionReason({ filename: "a.pdf", bytes: 0 })).toContain(
      "empty",
    );
  });

  it("refuses an object over 100 MB", () => {
    expect(
      uploadRejectionReason({ filename: "a.pdf", bytes: MAX_OBJECT_BYTES + 1 }),
    ).toContain("100 MB");
  });

  it("takes the extension from the last dot, not the first", () => {
    expect(
      uploadRejectionReason({ filename: "notice.2026.pdf", bytes: 10 }),
    ).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("replaces spaces with underscores", () => {
    expect(sanitizeFilename("Borrowing Notice.pdf")).toBe(
      "Borrowing_Notice.pdf",
    );
  });

  it("strips any path so a key cannot be steered", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("a/b/c.pdf")).toBe("c.pdf");
  });

  it("refuses a name with nothing left after sanitizing", () => {
    expect(() => sanitizeFilename("   ")).toThrow();
  });
});

describe("contentTypeFor", () => {
  it("gives a PDF the type the knowledge-base connector needs to parse it", () => {
    // The specific value matters more than it looks. The connector chooses a parser from the
    // stored content type, so this is the difference between an indexed document with text in it
    // and an indexed document with nothing in it, and the second reports no error anywhere.
    expect(contentTypeFor("notice.pdf")).toBe("application/pdf");
  });

  it("is case-insensitive about the extension", () => {
    // Names arrive from a file picker, so the extension's case is whatever the sender's machine
    // wrote. A case-sensitive lookup would refuse NOTICE.PDF as an unknown type.
    expect(contentTypeFor("NOTICE.PDF")).toBe("application/pdf");
  });

  it("reads the last dot, matching how the file was accepted in the first place", () => {
    expect(contentTypeFor("notice.2026.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("covers every extension the upload accepts", () => {
    // The pairing is the point: a type that passes uploadRejectionReason and then has no content
    // type is a file accepted at the door and unwritable at the destination, which surfaces as a
    // failed upload with an internal-sounding message. Asserted over ALLOWED_EXTENSIONS rather
    // than a hand-written list so widening that constant fails here instead of in production.
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(() => contentTypeFor(`file${ext}`)).not.toThrow();
    }
  });

  it("throws rather than falling back to octet-stream on an unmapped extension", () => {
    // A fallback here would be the bug itself: application/octet-stream is precisely the value
    // that makes a document ingest clean and hold no text, so the unexpected path must be loud.
    expect(() => contentTypeFor("sheet.xlsx")).toThrow(/no known content type/);
    expect(() => contentTypeFor("noextension")).toThrow(
      /no known content type/,
    );
  });
});
