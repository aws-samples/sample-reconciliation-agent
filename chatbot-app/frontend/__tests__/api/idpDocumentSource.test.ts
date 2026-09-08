/**
 * The source-document route: what the Documents tab streams beside a processed document.
 *
 * This route had no tests, and the two bugs it shipped with were both invisible without them --
 * each one turned a working preview into a plausible-looking failure message:
 *
 *  1. S3 stamps `binary/octet-stream` on every object uploaded without an explicit ContentType,
 *     which is every document the pipeline ingests. `ContentType ?? VIEWABLE_TYPES[ext]` never
 *     falls back on a non-null string, so every PDF was typed octet-stream and rendered as a
 *     download button rather than in the frame. The extension table was right there, unused.
 *  2. Without `s3:ListBucket`, S3 answers a GetObject for an absent key with `AccessDenied` rather
 *     than `NoSuchKey`, so the honest "the object is no longer in the input bucket" branch was
 *     unreachable and the tab printed a raw IAM denial instead.
 *
 * Both are asserted here so neither can come back quietly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const idpGraphQL = vi.fn();
vi.mock("@/lib/idpAppSync", () => ({
  idpGraphQL: (...a: unknown[]) => idpGraphQL(...a),
}));

import { GET } from "@/app/api/recon/idp-documents/[objectKey]/source/route";

/** A GetObject reply carrying `bytes` under the given stored content type. */
function s3Reply(contentType: string | undefined, bytes = "%PDF-1.4 fake") {
  return {
    ContentType: contentType,
    Body: { transformToByteArray: async () => new TextEncoder().encode(bytes) },
  };
}

/** Invoke the route for one object key. */
async function get(objectKey: string) {
  return GET(new Request("http://x"), {
    params: Promise.resolve({ objectKey }),
  });
}

describe("GET /api/recon/idp-documents/[objectKey]/source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("IDP_INPUT_BUCKET", "input-bucket");
    // The pipeline vouches for the key before a byte is read; every test below needs that to pass.
    idpGraphQL.mockResolvedValue({ getDocument: { ObjectKey: "k" } });
  });

  it("types a PDF from its extension when S3 stored binary/octet-stream", async () => {
    // THE regression. S3's default is a present-but-useless string, so this must not be trusted.
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    const res = await get("05-AGGREGATED-WIRE-20260904/One Wire - Advice.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("treats application/octet-stream and a blank type the same way", async () => {
    for (const stored of ["application/octet-stream", "", undefined]) {
      send.mockResolvedValue(s3Reply(stored));
      const res = await get("notices/n.pdf");
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
    }
  });

  it("respects a real content type S3 actually recorded", async () => {
    // The extension must NOT override a genuine answer -- a .txt stored as text/html is html.
    send.mockResolvedValue(s3Reply("image/png"));
    const res = await get("notices/scan.pdf");
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("leaves an unpreviewable extension as a download", async () => {
    // A spreadsheet in an <iframe> is a blank frame, which reads as broken rather than as a file the
    // browser cannot show -- so falling through to octet-stream is the correct outcome.
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
    const res = await get("notices/allocation.xlsx");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("serves the object inline so a PDF renders instead of downloading", async () => {
    send.mockResolvedValue(s3Reply("binary/octet-stream"));
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
    const res = await get("gone/x.pdf");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Source-Read-Error")).toContain("s3:ListBucket");
  });

  it("refuses a traversal key before calling anything", async () => {
    const res = await get("../../etc/passwd");
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(idpGraphQL).not.toHaveBeenCalled();
  });

  it("404s a key the pipeline has no record of, without reading S3", async () => {
    idpGraphQL.mockResolvedValue({ getDocument: null });
    const res = await get("invented/key.pdf");
    expect(res.status).toBe(404);
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
