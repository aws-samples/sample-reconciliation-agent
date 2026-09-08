// @vitest-environment node
/**
 * The Documents-tab read routes.
 *
 * These assertions guard failures that are all silent in the same way: the upstream GraphQL API answers
 * HTTP 200 even when it refused the query, so anything this layer gets wrong surfaces as "no documents"
 * rather than as an error. Hence the emphasis on what the routes REFUSE and on what they pass through
 * verbatim — a filter that was never applied and a key that was decoded twice both look like a working
 * screen with nothing on it.
 *
 * The transport is mocked; there is no live stack in CI, and signing a real request here would only test
 * the signer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const idpGraphQL = vi.fn();
vi.mock("@/lib/idpAppSync", () => ({ idpGraphQL }));

const listRoute = await import("@/app/api/recon/idp-documents/route");
const detailRoute =
  await import("@/app/api/recon/idp-documents/[objectKey]/route");

/** One upstream row, minimal but shaped like the real thing. */
function row(objectKey: string): Record<string, unknown> {
  return {
    ObjectKey: objectKey,
    ObjectStatus: "COMPLETED",
    WorkflowStatus: "SUCCEEDED",
    InitialEventTime: "2026-08-25T01:36:12Z",
    CompletionTime: "2026-08-25T01:38:09Z",
    ConfigVersion: "unapplied-cash-v1",
    EvaluationStatus: "COMPLETED",
    HITLStatus: null,
    HITLTriggered: null,
    HITLCompleted: null,
    HITLReviewOwner: null,
    HITLReviewedBy: null,
    PageCount: 4,
    ConfidenceAlertCount: 2,
  };
}

/** The variables the route passed to the transport on its most recent call. */
function lastVariables(): Record<string, unknown> {
  return idpGraphQL.mock.calls.at(-1)![0].variables as Record<string, unknown>;
}

beforeEach(() => {
  idpGraphQL.mockReset();
});

describe("GET /api/recon/idp-documents", () => {
  it("returns the rows, the continuation token, and the window it actually used", async () => {
    idpGraphQL.mockResolvedValue({
      listDocuments: { nextToken: "tok", Documents: [row("a/one.pdf")] },
    });
    const res = await listRoute.GET(
      new Request("http://x/api/recon/idp-documents"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    expect(body.nextToken).toBe("tok");
    expect(body.count).toBe(1);
    // The echoed window is what lets the tab state the range on screen instead of the range requested.
    expect(typeof body.window.startDateTime).toBe("string");
    expect(typeof body.window.endDateTime).toBe("string");
  });

  it("defaults to a 30-day window when the caller gives none", async () => {
    idpGraphQL.mockResolvedValue({
      listDocuments: { nextToken: null, Documents: [] },
    });
    await listRoute.GET(new Request("http://x/api/recon/idp-documents"));
    const v = lastVariables();
    const span = Date.parse(v.end as string) - Date.parse(v.start as string);
    expect(span).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -4);
  });

  it("refuses a `view` parameter instead of forwarding it", async () => {
    // The upstream query has no such argument, and asking for one is a validation error returned as
    // HTTP 200 — so forwarding it would read as an empty result, and ignoring it would read as a
    // filter that worked. Neither is acceptable, so it is a 400 and nothing is called.
    const res = await listRoute.GET(
      new Request("http://x/api/recon/idp-documents?view=TEST"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/production\/test filter/i);
    expect(idpGraphQL).not.toHaveBeenCalled();
  });

  it("clamps an oversized limit rather than passing it upstream", async () => {
    idpGraphQL.mockResolvedValue({
      listDocuments: { nextToken: null, Documents: [] },
    });
    await listRoute.GET(
      new Request("http://x/api/recon/idp-documents?limit=5000"),
    );
    expect(lastVariables().limit).toBe(100);
  });

  it("rejects a non-integer limit", async () => {
    const res = await listRoute.GET(
      new Request("http://x/api/recon/idp-documents?limit=abc"),
    );
    expect(res.status).toBe(400);
    expect(idpGraphQL).not.toHaveBeenCalled();
  });

  it("rejects an unparseable timestamp and an inverted window", async () => {
    const bad = await listRoute.GET(
      new Request("http://x/api/recon/idp-documents?startDateTime=yesterday"),
    );
    expect(bad.status).toBe(400);
    const inverted = await listRoute.GET(
      new Request(
        "http://x/api/recon/idp-documents?startDateTime=2026-09-01T00:00:00Z&endDateTime=2026-08-01T00:00:00Z",
      ),
    );
    expect(inverted.status).toBe(400);
    expect(idpGraphQL).not.toHaveBeenCalled();
  });

  it("passes the continuation token through unchanged", async () => {
    idpGraphQL.mockResolvedValue({
      listDocuments: { nextToken: null, Documents: [] },
    });
    // Real tokens are base64 with `=` padding; a token mangled in transit pages back to page one
    // forever without ever failing.
    const token = "eyJ2ZXJzaW9uIjozfQ==";
    await listRoute.GET(
      new Request(
        `http://x/api/recon/idp-documents?nextToken=${encodeURIComponent(token)}`,
      ),
    );
    expect(lastVariables().nextToken).toBe(token);
  });

  it("reports an upstream refusal as 502, not as an empty list", async () => {
    idpGraphQL.mockRejectedValue(
      new Error("IDP GraphQL error: Not Authorized to access listDocuments"),
    );
    const res = await listRoute.GET(
      new Request("http://x/api/recon/idp-documents"),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Not Authorized/);
  });

  it("treats a null page as an empty list rather than an error", async () => {
    idpGraphQL.mockResolvedValue({ listDocuments: null });
    const res = await listRoute.GET(
      new Request("http://x/api/recon/idp-documents"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toEqual([]);
    expect(body.count).toBe(0);
  });
});

describe("GET /api/recon/idp-documents/[objectKey]", () => {
  it("returns the document for a key containing slashes", async () => {
    idpGraphQL.mockResolvedValue({ getDocument: row("batch-1/notice.pdf") });
    const res = await detailRoute.GET(new Request("http://x/"), {
      params: Promise.resolve({ objectKey: "batch-1/notice.pdf" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).document.ObjectKey).toBe("batch-1/notice.pdf");
    expect(lastVariables().key).toBe("batch-1/notice.pdf");
  });

  it("does not decode the key a second time", async () => {
    // Next.js has already decoded the segment. A key with a literal `%` is the only case that catches a
    // double decode — ordinary keys survive it, which is why this assertion exists at all. `%20abc`
    // would decode to a space and `%zz` would throw URIError.
    idpGraphQL.mockResolvedValue({ getDocument: row("odd/100%25 done.pdf") });
    const key = "odd/100% done.pdf";
    const res = await detailRoute.GET(new Request("http://x/"), {
      params: Promise.resolve({ objectKey: key }),
    });
    expect(res.status).toBe(200);
    expect(lastVariables().key).toBe(key);
  });

  it("answers 404 when no document has that key", async () => {
    // Null with no GraphQL error means unknown key. Rendering a blank detail page instead would look
    // like a document that processed and produced nothing.
    idpGraphQL.mockResolvedValue({ getDocument: null });
    const res = await detailRoute.GET(new Request("http://x/"), {
      params: Promise.resolve({ objectKey: "missing.pdf" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/missing\.pdf/);
  });

  it("reports an upstream failure as 502", async () => {
    idpGraphQL.mockRejectedValue(new Error("IDP GraphQL HTTP 500: boom"));
    const res = await detailRoute.GET(new Request("http://x/"), {
      params: Promise.resolve({ objectKey: "any.pdf" }),
    });
    expect(res.status).toBe(502);
  });
});
