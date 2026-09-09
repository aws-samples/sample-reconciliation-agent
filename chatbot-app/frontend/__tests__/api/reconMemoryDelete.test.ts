// @vitest-environment node
/**
 * Tests for `DELETE /api/recon/memory` — removing consolidated long-term memory records.
 *
 * Three things are worth pinning here. It is admin-gated, because deleting what the agent recalls
 * before every classification changes how the platform behaves. An unconfigured memory is a refusal
 * rather than an empty success, because a delete that reports success while deleting nothing is the
 * one answer an operator cannot recover from. And a partial failure is reported per record, because
 * "some of your selection is gone" is only actionable if the response says which.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.RECON_MEMORY_ID = "recon_test_memory-abc123";

const agentcoreSend = vi.fn();
// The gate itself is tested in reconAdminGuard.test.ts; mocked here so these tests stay about the
// delete contract, with one case re-checking that this endpoint honours a refusal.
const requireReconAdmin = vi.fn();

vi.mock("@/lib/reconAdmin", () => ({ requireReconAdmin }));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi
    .fn()
    .mockImplementation(() => ({ send: agentcoreSend })),
  RetrieveMemoryRecordsCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "Retrieve", ...i })),
  BatchDeleteMemoryRecordsCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "BatchDelete", ...i })),
}));

const { DELETE, parseMemoryDeleteIds } =
  await import("@/app/api/recon/memory/route");

/** Issue a DELETE with the given JSON body. */
function del(body: unknown) {
  return DELETE(
    new Request("http://x/api/recon/memory", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RECON_MEMORY_ID = "recon_test_memory-abc123";
  requireReconAdmin.mockResolvedValue({ actor: "operator@x.com" });
});

describe("parseMemoryDeleteIds", () => {
  it("accepts a list of ids and collapses duplicates", () => {
    expect(parseMemoryDeleteIds({ ids: ["a", " b ", "a"] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("refuses a body that is not an object with an ids array", () => {
    expect(() => parseMemoryDeleteIds(null)).toThrow(/`ids` array/);
    expect(() => parseMemoryDeleteIds({ ids: "a" })).toThrow(/`ids` array/);
  });

  it("refuses an empty selection", () => {
    expect(() => parseMemoryDeleteIds({ ids: [] })).toThrow(/at least one/);
  });

  it("refuses a blank or non-string id rather than skipping it", () => {
    expect(() => parseMemoryDeleteIds({ ids: ["a", "  "] })).toThrow(
      /non-empty string/,
    );
    expect(() => parseMemoryDeleteIds({ ids: ["a", 7] })).toThrow(
      /non-empty string/,
    );
  });

  it("refuses more ids than the cap instead of silently trimming to it", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    expect(() => parseMemoryDeleteIds({ ids })).toThrow(/at most 50/);
  });
});

describe("DELETE /api/recon/memory", () => {
  it("deletes the selected records and reports them back", async () => {
    agentcoreSend.mockResolvedValue({
      successfulRecords: [
        { memoryRecordId: "rec-1" },
        { memoryRecordId: "rec-2" },
      ],
      failedRecords: [],
    });
    const resp = await del({ ids: ["rec-1", "rec-2"] });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      deleted: ["rec-1", "rec-2"],
      failed: [],
    });
    expect(agentcoreSend).toHaveBeenCalledTimes(1);
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({
      __cmd: "BatchDelete",
      memoryId: "recon_test_memory-abc123",
      records: [{ memoryRecordId: "rec-1" }, { memoryRecordId: "rec-2" }],
    });
  });

  it("reports a partial failure per record rather than as a blanket error", async () => {
    agentcoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: "rec-1" }],
      failedRecords: [
        { memoryRecordId: "rec-2", errorMessage: "record not found" },
      ],
    });
    const resp = await del({ ids: ["rec-1", "rec-2"] });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      deleted: ["rec-1"],
      failed: [{ id: "rec-2", error: "record not found" }],
    });
  });

  it("honours the admin gate's refusal and never calls AgentCore", async () => {
    const { NextResponse } = await import("next/server");
    requireReconAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "not an admin" }, { status: 403 }),
    });
    const resp = await del({ ids: ["rec-1"] });
    expect(resp.status).toBe(403);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("rejects a bad body with 400 and deletes nothing", async () => {
    const resp = await del({ ids: [] });
    expect(resp.status).toBe(400);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("refuses with 409 when no memory is configured", async () => {
    // Deliberately NOT an empty success: telling an operator their records are gone when the request
    // never reached a memory resource is the one failure mode they cannot detect afterwards.
    vi.resetModules();
    process.env.RECON_MEMORY_ID = "";
    const route = await import("@/app/api/recon/memory/route");
    const resp = await route.DELETE(
      new Request("http://x/api/recon/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["rec-1"] }),
      }),
    );
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/RECON_MEMORY_ID/);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });
});
