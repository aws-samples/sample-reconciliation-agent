import { describe, it, expect, vi } from "vitest";
import { getCase, approveCase, rejectCase } from "@/lib/reconApi";

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

describe("reconApi", () => {
  it("attaches the caller's ID token to every BFF call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ item_id: "i-1" }) });
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ item_id: "idp-Borrowing_Notice_#2.pdf" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getCase("idp-Borrowing_Notice_#2.pdf");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/recon/cases/idp-Borrowing_Notice_%232.pdf",
      expect.anything(),
    );
  });

  it("approveCase POSTs the approve action to the same-origin case route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "APPROVED" }),
    });
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "IN_PROGRESS" }),
    });
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

  it("getCase exposes classification and per-step reasoning/confidence", async () => {
    const caseJson = {
      item_id: "i-1",
      class_id: "timing",
      classification_confidence: "0.9",
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => caseJson }),
    );
    const c = await getCase("i-1", "token-abc");
    expect(c.classification_reasoning).toBe("value date off by 1d");
    expect(c.steps?.[0].reasoning).toBe("amounts match");
    expect(c.steps?.[0].confidence).toBe("0.83");
  });
});
