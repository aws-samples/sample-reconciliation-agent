/**
 * The two routes that serve extracted fields: one document for the detail panel, many for the table.
 *
 * Both wrap `src/lib/noticeExtraction.ts`, so what is worth testing here is the edges the reader does
 * not own:
 *
 *  - The object key arrives already decoded by Next.js and must NOT be decoded again — a second pass
 *    mangles any key carrying a literal `%`, and the symptom is one document that cannot be opened
 *    rather than anything that looks like a routing mistake.
 *  - A document recon holds no notice for is a 404, not a 502. Collapsing the two would make an
 *    unmapped document class indistinguishable from the notices table being unreachable.
 *  - `unavailable` travels beside `sections` on the per-document route. A notice that EXISTS but whose
 *    per-field detail was dropped to fit the row is neither a 404 nor an empty extraction, and the
 *    drawer shows it as its own state.
 *  - On the bulk route, one unanswerable document must cost the caller that document and not the other
 *    ninety-nine — while an unusable object key in the REQUEST is refused outright, because a caller who
 *    sent one should find out rather than receive a result set quietly missing a row.
 */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const readNoticeExtraction = vi.fn();
const readNoticeExtractions = vi.fn();

// `UnknownDocumentError` has to be the real class: the per-document route branches on `instanceof`, and
// a stub that merely looked like it would send every 404 out as a 502.
//
// The mocks are handed over directly rather than wrapped in forwarding arrows. A wrapper passes the
// mock's rejected promise through a second chain, and the one vitest is not watching surfaces as an
// unhandled rejection that fails the test even though the route caught it and answered correctly.
vi.mock("@/lib/noticeExtraction", async () => {
  const actual = await vi.importActual<typeof import("@/lib/noticeExtraction")>(
    "@/lib/noticeExtraction",
  );
  return { ...actual, readNoticeExtraction, readNoticeExtractions };
});

// Imported here rather than statically so the factory above closes over initialised `vi.fn()`s: a
// static import is hoisted above the `const`, leaving them in their temporal dead zone when it runs.
const { UnknownDocumentError } = await import("@/lib/noticeExtraction");
const { GET } =
  await import("@/app/api/recon/idp-documents/[objectKey]/extraction/route");
const { POST } = await import("@/app/api/recon/idp-extractions/route");

/** One section, enough to be recognisable in a response body. */
const SECTION = {
  section_id: "1",
  classification: "paydown_notice",
  page_ids: [1],
  fields: { BorrowerName: "Cascade Holdings LLC" },
  confidences: [
    { field: "BorrowerName", confidence: 1.0, threshold: 0.8, extracted: true },
  ],
  mean_confidence: 1.0,
  alert_count: 0,
};

/** A POST to the bulk route carrying `body`. */
function post(body: unknown): Request {
  return new Request("http://localhost/api/recon/idp-extractions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("GET /api/recon/idp-documents/[objectKey]/extraction", () => {
  // A block body on purpose. `mockReset()` returns the spy for chaining, and vitest treats whatever a
  // hook RETURNS as that test's cleanup function -- so the concise form gets the mock invoked with no
  // arguments during teardown, which fails inside any implementation that reads its argument.
  beforeEach(() => {
    readNoticeExtraction.mockReset();
  });

  it("passes the already-decoded key through untouched", async () => {
    readNoticeExtraction.mockResolvedValue({
      sections: [SECTION],
      unavailable: null,
    });
    // Next.js hands the segment over decoded. A key with a literal `%` and a space survives only if
    // this route does not decode it a second time.
    const key = "recon/Paydown Notice 50%.pdf";
    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ objectKey: key }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sections: [SECTION],
      unavailable: null,
    });
    expect(readNoticeExtraction).toHaveBeenCalledWith({ objectKey: key });
  });

  it("refuses a traversal or absolute key", async () => {
    for (const objectKey of ["../../etc/passwd", "/etc/passwd", ""]) {
      const res = await GET(new Request("http://localhost"), {
        params: Promise.resolve({ objectKey }),
      });
      expect(res.status).toBe(400);
    }
    expect(readNoticeExtraction).not.toHaveBeenCalled();
  });

  it("answers 404 for a document recon holds no notice for", async () => {
    readNoticeExtraction.mockRejectedValue(
      new UnknownDocumentError("recon has no notice for object key x"),
    );
    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ objectKey: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("answers 200 with the reason when the notice carries no per-field detail", async () => {
    // The third state, and the one that is easiest to collapse into one of the other two. The notice
    // EXISTS -- reconciliation has it, the interceptor can score it -- and only the display detail is
    // missing, so answering 404 or an empty 200 would both misreport what happened.
    readNoticeExtraction.mockResolvedValue({
      sections: [],
      unavailable: "the extraction was 812345 bytes, over the row budget",
    });
    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ objectKey: "big.pdf" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections).toEqual([]);
    expect(body.unavailable).toContain("over the row budget");
  });

  it("answers 502 when the notices table cannot be read", async () => {
    // A different answer from the 404 above on purpose: one means recon has no notice, the other means
    // we could not look.
    readNoticeExtraction.mockRejectedValue(new Error("access denied"));
    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ objectKey: "x" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("access denied");
  });
});

describe("POST /api/recon/idp-extractions", () => {
  // A block body on purpose, for the same teardown reason as the block above.
  beforeEach(() => {
    readNoticeExtractions.mockReset();
  });

  it("asks for every key in one call and answers with what came back", async () => {
    // One call, not one per key: the reader batches, and a route that looped would undo that.
    readNoticeExtractions.mockResolvedValue({
      extractions: { "a.pdf": [SECTION], "b.pdf": [SECTION] },
      failed: {},
    });
    const res = await POST(post({ objectKeys: ["a.pdf", "b.pdf"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.extractions).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(body.failed).toEqual({});
    expect(readNoticeExtractions).toHaveBeenCalledTimes(1);
    expect(readNoticeExtractions).toHaveBeenCalledWith({
      objectKeys: ["a.pdf", "b.pdf"],
    });
  });

  it("passes a per-key reason straight through rather than failing the request", async () => {
    readNoticeExtractions.mockResolvedValue({
      extractions: { "ok.pdf": [SECTION] },
      failed: { "gone.pdf": "recon has no notice for this document" },
    });
    const res = await POST(post({ objectKeys: ["ok.pdf", "gone.pdf"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.extractions)).toEqual(["ok.pdf"]);
    expect(body.failed["gone.pdf"]).toContain("no notice");
  });

  it("answers 502 when the whole read fails rather than blaming every key", async () => {
    // A misconfigured table name is not attributable to any one document, and reporting it against all
    // hundred would read as a hundred unextracted documents.
    readNoticeExtractions.mockRejectedValue(
      new Error("NOTICES_TABLE is not set"),
    );
    const res = await POST(post({ objectKeys: ["x.pdf"] }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("NOTICES_TABLE");
  });

  it("refuses the whole request when any key is unusable", async () => {
    for (const keys of [
      ["ok.pdf", "../secret"],
      ["ok.pdf", "/etc/passwd"],
      ["ok.pdf", ""],
      ["ok.pdf", 7],
    ]) {
      const res = await POST(post({ objectKeys: keys }));
      expect(res.status).toBe(400);
    }
    // Nothing was looked up: a partial answer would hide the bad key.
    expect(readNoticeExtractions).not.toHaveBeenCalled();
  });

  it("refuses a missing, empty or over-long key list", async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ objectKeys: [] }))).status).toBe(400);
    expect((await POST(post({ objectKeys: "a.pdf" }))).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `${i}.pdf`);
    const res = await POST(post({ objectKeys: tooMany }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("101");
  });

  it("refuses a body that is not JSON at all rather than throwing", async () => {
    const res = await POST(
      new Request("http://localhost/api/recon/idp-extractions", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});
