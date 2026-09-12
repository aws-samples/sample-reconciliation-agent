import { describe, it, expect, vi } from "vitest";
import {
  getCase,
  approveCase,
  rejectCase,
  getLambdaSource,
} from "@/lib/reconApi";

// There is no signed-in session in the test environment, so stand in for the authorized
// transport. reconFetch's own header merging is covered in recon-auth.test.ts; what matters here
// is that reconApi routes EVERY call through it — a bare fetch would 401 against the middleware.
vi.mock("@/lib/recon-auth", () => ({
  reconFetch: (input: string, init: RequestInit = {}) =>
    fetch(input, {
      ...init,
      headers: {
        Authorization: "Bearer test-id-token",
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
}));

/** A 2xx stand-in carrying the readers the shared JSON reader uses (`text()` first, `json()` on errors). */
const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("reconApi", () => {
  it("attaches the caller's ID token to every BFF call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ item_id: "i-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await getCase("i-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/recon/cases/i-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-id-token",
        }),
      }),
    );
  });

  it("getCase URL-encodes an item_id containing '#' and spaces", async () => {
    // Regression: ids like "idp-Borrowing_Notice_#2.pdf" must not let '#' become a URL
    // fragment, or the BFF receives a truncated id and returns not-found.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ item_id: "idp-Borrowing_Notice_#2.pdf" }));
    vi.stubGlobal("fetch", fetchMock);
    await getCase("idp-Borrowing_Notice_#2.pdf");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/recon/cases/idp-Borrowing_Notice_%232.pdf",
      expect.anything(),
    );
  });

  it("approveCase POSTs the approve action to the same-origin case route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ status: "APPROVED" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await approveCase("i-1");
    expect(res.status).toBe("APPROVED");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/recon/cases/i-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      }),
    );
  });

  it("rejectCase sends the correction comment + outcome", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ status: "IN_PROGRESS" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await rejectCase("i-1", "value date is T+1", "reprocess");
    expect(res.status).toBe("IN_PROGRESS");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/recon/cases/i-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "reject",
          comment: "value date is T+1",
          outcome: "reprocess",
        }),
      }),
    );
  });

  // Two different `confidence` keys survive on this payload and they mean different things — the
  // point of the assertions below. The case-level one is the ONLY confidence the platform computes:
  // satisfied/prescribed required evidence steps for the classified skill (0.83 == 5 of 6 on
  // record-match-review). The step-level one is optional and historical — rows written before
  // 2026-09-04 carry a number the model reported about itself, nothing reads it, and no new row
  // sets it. There is deliberately no `classification_confidence` alongside
  // `classification_reasoning`: the classifier returns a label and a why, never a score.
  it("getCase exposes classification and per-step reasoning/confidence", async () => {
    const caseJson = {
      item_id: "i-1",
      class_id: "timing",
      classification_reasoning: "value date off by 1d",
      confidence: "0.83",
      steps: [
        {
          skill: "record-match-review",
          confidence: "0.83",
          reasoning: "amounts match",
          evidence: ["bank=100.00"],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(caseJson)));
    const c = await getCase("i-1", "token-abc");
    expect(c.classification_reasoning).toBe("value date off by 1d");
    expect(c.confidence).toBe("0.83");
    expect(c.steps?.[0].reasoning).toBe("amounts match");
    expect(c.steps?.[0].confidence).toBe("0.83");
  });

  it("getCase leaves a step's absent confidence absent rather than defaulting it", async () => {
    // Every step written after 2026-09-04 omits the key. Nothing may substitute a number for it:
    // a 0 would render as a real self-assessment of zero, which is worse than showing nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse({
          item_id: "i-1",
          steps: [{ skill: "record-match-review", reasoning: "amounts match" }],
        }),
      ),
    );
    const c = await getCase("i-1", "token-abc");
    expect(c.steps?.[0].confidence).toBeUndefined();
  });

  // The route keys its S3 prefix off ?src=, and "tier1" is its default — passed as no query string
  // at all. A wrong mapping here shows the operator someone else's code in the read-only viewer.
  it.each([
    [undefined, "/api/recon/lambda-src"],
    ["tier1", "/api/recon/lambda-src"],
    ["agent", "/api/recon/lambda-src?src=agent"],
    ["guard", "/api/recon/lambda-src?src=guard"],
  ])("getLambdaSource(%s) requests %s", async (src, url) => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await getLambdaSource(src as "tier1" | "agent" | "guard" | undefined);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.anything());
  });
});
