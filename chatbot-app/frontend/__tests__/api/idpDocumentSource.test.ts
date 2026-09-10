/**
 * The source-document route: what the Documents tab streams beside an ingested document.
 *
 * Four failure modes here are invisible without tests, because each turns a working preview into a
 * plausible-looking failure message:
 *
 *  1. S3 stamps `binary/octet-stream` on every object uploaded without an explicit ContentType,
 *     which is every document the pipeline ingests. `ContentType ?? VIEWABLE_TYPES[ext]` never
 *     falls back on a non-null string, so every PDF is typed octet-stream and renders as a
 *     download button rather than in the frame. The extension table sits right there, unused.
 *  2. Without `s3:ListBucket`, S3 answers a GetObject for an absent key with `AccessDenied` rather
 *     than `NoSuchKey`, so the honest "the object is no longer in the input bucket" branch is
 *     unreachable and the tab prints a raw IAM denial instead.
 *
 *  3. The S3 key comes from the row's `source_document`, not from the URL parameter. Reading the
 *     parameter would serve whatever object a caller named, and a route that happens to work for every
 *     key where the two agree gives no sign of it.
 *  4. The gate is on `parse_method` and NOT on `record_kind`. A tracking-only row carries
 *     `parse_method: "IDP"` precisely so a FAILED document's source PDF stays viewable -- which is
 *     exactly when an operator needs to look at it, so refusing those rows would hide the file at the
 *     one moment it mattered.
 *
 * All four are asserted here so none can arrive quietly.
 */
import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

// A separate mock from the S3 one: the assertions below turn on WHICH key each service was given, so the
// two calls cannot share a spy.
const ddbSend = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = ddbSend;
  },
  GetItemCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

process.env.NOTICES_TABLE = "recon-dev-notices";

import { GET } from "@/app/api/recon/idp-documents/[objectKey]/source/route";

/** A GetObject reply carrying `bytes` under the given stored content type. */
function s3Reply(contentType: string | undefined, bytes = "%PDF-1.4 fake") {
  return {
    ContentType: contentType,
    Body: { transformToByteArray: async () => new TextEncoder().encode(bytes) },
  };
}

/** A stored row that vouches for `objectKey` and points at `sourceDocument`. */
function ddbReply(overrides: Record<string, unknown> = {}): {
  Item: Record<string, unknown>;
} {
  return {
    Item: marshall({
      notice_id: "idp-k",
      source_document: "k",
      parse_method: "IDP",
      ...overrides,
    }),
  };
}

/** Invoke the route for one object key. */
async function get(objectKey: string) {
  return GET(new Request("http://x"), {
    params: Promise.resolve({ objectKey }),
  });
}

/** The `GetObjectCommand` input the route built on its most recent call. */
function lastS3Key(): string {
  return (send.mock.calls.at(-1)![0] as { input: { Key: string } }).input.Key;
}

describe("GET /api/recon/idp-documents/[objectKey]/source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("IDP_INPUT_BUCKET", "input-bucket");
    // Recon's own row vouches for the key before a byte is read; every test below needs that to pass.
    ddbSend.mockResolvedValue(ddbReply());
  });

  it("probes recon's notice row, projecting only what it needs to resolve a key", async () => {
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    ddbSend.mockResolvedValue(ddbReply({ source_document: "notices/n.pdf" }));
    await get("notices/n.pdf");
    const probe = (
      ddbSend.mock.calls.at(-1)![0] as { input: Record<string, unknown> }
    ).input;
    expect(probe.TableName).toBe("recon-dev-notices");
    expect(probe.Key).toEqual({ notice_id: { S: "idp-notices/n.pdf" } });
    // A notice row carries the document's whole extracted content, which an existence probe has no use
    // for.
    expect(probe.ProjectionExpression).toBe(
      "notice_id, source_document, parse_method",
    );
  });

  it("reads the S3 key the row recorded, not the one in the URL", async () => {
    // The parameter is untrusted input; `source_document` is what recon itself ingested. A test where
    // the two agree could not tell the difference, so here they deliberately differ.
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    ddbSend.mockResolvedValue(
      ddbReply({ source_document: "05-WIRE-20260904/One Wire - Advice.pdf" }),
    );
    const res = await get("whatever/the-caller-typed.pdf");
    expect(res.status).toBe(200);
    expect(lastS3Key()).toBe("05-WIRE-20260904/One Wire - Advice.pdf");
    // The filename and the content type follow the RESOLVED key, because those are the bytes served.
    expect(res.headers.get("Content-Disposition")).toBe(
      'inline; filename="One Wire - Advice.pdf"',
    );
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("serves the source file of a FAILED document, whose row is tracking-only", async () => {
    // ⚠️ `record_kind == "document"` means the pipeline finished and recon extracted no notice. That row
    // still carries `parse_method: "IDP"`, and this is the case an operator most needs the PDF for.
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    ddbSend.mockResolvedValue(
      ddbReply({
        record_kind: "document",
        source_document: "failed/unreadable.pdf",
        notice_failure_reason: "no amount extracted",
      }),
    );
    const res = await get("failed/unreadable.pdf");
    expect(res.status).toBe(200);
    expect(lastS3Key()).toBe("failed/unreadable.pdf");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toContain("%PDF");
  });

  it("404s a notice that was not ingested from a document", async () => {
    // Forward-defence for the structured-feed adapter: those rows will have no source file at all, and
    // saying so beats a 404 about a missing object that would send someone looking in the bucket.
    ddbSend.mockResolvedValue(
      ddbReply({ parse_method: "STRUCTURED_FEED", source_document: "" }),
    );
    const res = await get("feed/row-42");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not ingested from a document");
    expect(send).not.toHaveBeenCalled();
  });

  it("types a PDF from its extension when S3 stored binary/octet-stream", async () => {
    // ⚠️ The trap. S3's default is a present-but-useless string, so it must not be trusted.
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    ddbSend.mockResolvedValue(
      ddbReply({
        source_document: "05-AGGREGATED-WIRE-20260904/One Wire - Advice.pdf",
      }),
    );
    const res = await get("05-AGGREGATED-WIRE-20260904/One Wire - Advice.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("treats application/octet-stream and a blank type the same way", async () => {
    ddbSend.mockResolvedValue(ddbReply({ source_document: "notices/n.pdf" }));
    for (const stored of ["application/octet-stream", "", undefined]) {
      send.mockResolvedValue(s3Reply(stored));
      const res = await get("notices/n.pdf");
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
    }
  });

  it("respects a real content type S3 actually recorded", async () => {
    // The extension must NOT override a genuine answer -- a .txt stored as text/html is html.
    send.mockResolvedValue(s3Reply("image/png"));
    ddbSend.mockResolvedValue(
      ddbReply({ source_document: "notices/scan.pdf" }),
    );
    const res = await get("notices/scan.pdf");
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("leaves an unpreviewable extension as a download", async () => {
    // A spreadsheet in an <iframe> is a blank frame, which reads as broken rather than as a file the
    // browser cannot show -- so falling through to octet-stream is the correct outcome.
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    ddbSend.mockResolvedValue(
      ddbReply({ source_document: "notices/allocation.xlsx" }),
    );
    const res = await get("notices/allocation.xlsx");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("serves the object inline so a PDF renders instead of downloading", async () => {
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    ddbSend.mockResolvedValue(ddbReply({ source_document: "a/b/Advice.pdf" }));
    const res = await get("a/b/Advice.pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'inline; filename="Advice.pdf"',
    );
    // Private and short: these are customer financial documents, so no shared cache may hold them.
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("reports a missing object as a 404 that names the key, for NoSuchKey", async () => {
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { name: "NoSuchKey" }),
    );
    ddbSend.mockResolvedValue(ddbReply({ source_document: "gone/x.pdf" }));
    const res = await get("gone/x.pdf");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no longer in the input bucket");
  });

  it("reports AccessDenied as the same 404, and keeps the raw error on a header", async () => {
    // S3 answers AccessDenied for an absent key unless the caller also holds ListBucket. Mapping it
    // here means a dropped grant degrades to "the object is gone" instead of pasting an IAM denial
    // at the operator -- but the verbatim cause stays diagnosable.
    send.mockRejectedValue(
      Object.assign(new Error("not authorized to perform: s3:ListBucket"), {
        name: "AccessDenied",
      }),
    );
    ddbSend.mockResolvedValue(ddbReply({ source_document: "gone/x.pdf" }));
    const res = await get("gone/x.pdf");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Source-Read-Error")).toContain("s3:ListBucket");
  });

  it("refuses a traversal key before reading anything at all", async () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", ""]) {
      const res = await get(bad);
      expect(res.status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("404s a key recon has no row for, without reading S3", async () => {
    ddbSend.mockResolvedValue({});
    const res = await get("invented/key.pdf");
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failed probe as 500, because the notices table is recon's own", async () => {
    ddbSend.mockRejectedValue(new Error("dynamodb:GetItem denied"));
    const res = await get("a/b.pdf");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dynamodb:GetItem");
    expect(send).not.toHaveBeenCalled();
  });

  it("is loud when no input bucket is configured", async () => {
    // A 404 here would read as "the pipeline lost my file" rather than as a missing deploy value.
    vi.stubEnv("IDP_INPUT_BUCKET", "");
    const res = await get("a/b.pdf");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("IDP_INPUT_BUCKET");
  });
});
