// @vitest-environment node
/**
 * Tests for `GET /api/recon/memory` — the consolidated long-term memory records the Lessons tab lists.
 *
 * The route enumerates recon domains from the DynamoDB lessons ledger, then runs one semantic
 * `RetrieveMemoryRecords` per `reconciliation/lessons/{domain}` namespace. Three things are pinned
 * here because the panel depends on them and a shared client could most easily lose them: the
 * response is a FLAT array whose every record carries its `domain`; a domain whose retrieve fails
 * yields nothing while the other domains still return (advisory context degrades, it does not fail
 * the request); and the retrieve is a semantic search with the domain as its query and topK 25, not
 * a paginated list.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";

import { agentCoreModule, dynamoDbModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { jsonRequest } from "../helpers/http";

const MEMORY_ID = "recon_test_memory-abc123";
const env = scopedEnv({
  RECON_MEMORY_ID: MEMORY_ID,
  LESSONS_TABLE: "recon-lessons-test",
  AWS_REGION: "us-east-1",
});
afterAll(() => env.restore());

const ddbSend = vi.fn();
const agentcoreSend = vi.fn();
// The gate is covered by api-auth's own tests; mocked so these stay about the route's contract.
const authorizeRequest = vi.fn();

vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));
vi.mock("@/lib/reconAdmin", () => ({ requireReconAdmin: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => dynamoDbModule(ddbSend));
vi.mock("@aws-sdk/client-bedrock-agentcore", () =>
  agentCoreModule(agentcoreSend),
);

const { GET } = await import("@/app/api/recon/memory/route");

const get = () => GET(jsonRequest("GET", "http://x/api/recon/memory"));

/** One SDK record summary as `RetrieveMemoryRecords` returns it. */
function summary(id: string, text: string, createdAt: string) {
  return {
    memoryRecordId: id,
    content: { text },
    createdAt: new Date(createdAt),
  };
}

/** A ledger with two domains, one of them twice — the enumeration must de-duplicate. */
const LEDGER = {
  Items: [
    marshall({ lesson_id: "l-1", domain: "lending" }),
    marshall({ lesson_id: "l-2", domain: "loan_ops" }),
    marshall({ lesson_id: "l-3", domain: "lending" }),
  ],
};

/** Answer each namespace's retrieve with the given summaries, or throw the given error. */
function retrieveByNamespace(perNamespace: Record<string, unknown[] | Error>) {
  agentcoreSend.mockImplementation(
    async (cmd: { __cmd: string; namespace: string }) => {
      const hit = perNamespace[cmd.namespace];
      if (hit instanceof Error) throw hit;
      return { memoryRecordSummaries: hit ?? [] };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  env.set({ RECON_MEMORY_ID: MEMORY_ID });
  authorizeRequest.mockResolvedValue({ ok: true, subject: "analyst" });
  ddbSend.mockResolvedValue(LEDGER);
});

describe("GET /api/recon/memory", () => {
  it("enumerates domains from the lessons ledger and retrieves each namespace semantically", async () => {
    retrieveByNamespace({
      "reconciliation/lessons/lending": [
        summary(
          "rec-l1",
          "Paydown breaks under 1 USD are rounding.",
          "2026-08-10T00:00:00Z",
        ),
        // A record with no text is dropped, as the backend drops it.
        summary("rec-blank", "", "2026-08-11T00:00:00Z"),
      ],
      "reconciliation/lessons/loan_ops": [
        summary(
          "rec-o1",
          "Fix the facility mapping before comparing amounts.",
          "2026-08-12T00:00:00Z",
        ),
      ],
    });

    const resp = await get();
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // A flat array — not grouped by domain — with `domain` on every record.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([
      {
        id: "rec-l1",
        domain: "lending",
        namespace: "reconciliation/lessons/lending",
        content: "Paydown breaks under 1 USD are rounding.",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "rec-o1",
        domain: "loan_ops",
        namespace: "reconciliation/lessons/loan_ops",
        content: "Fix the facility mapping before comparing amounts.",
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ]);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(ddbSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Scan",
      TableName: "recon-lessons-test",
    });

    // One semantic Retrieve per distinct domain: the domain is the query, topK is 25.
    expect(agentcoreSend).toHaveBeenCalledTimes(2);
    const retrieves = agentcoreSend.mock.calls.map((c) => c[0]);
    expect(retrieves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          __cmd: "Retrieve",
          memoryId: MEMORY_ID,
          namespace: "reconciliation/lessons/lending",
          searchCriteria: { searchQuery: "lending", topK: 25 },
        }),
        expect.objectContaining({
          __cmd: "Retrieve",
          memoryId: MEMORY_ID,
          namespace: "reconciliation/lessons/loan_ops",
          searchCriteria: { searchQuery: "loan_ops", topK: 25 },
        }),
      ]),
    );
  });

  it("still returns the other domain's records when one domain's retrieve fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    retrieveByNamespace({
      "reconciliation/lessons/lending": [
        summary(
          "rec-l1",
          "Paydown breaks under 1 USD are rounding.",
          "2026-08-10T00:00:00Z",
        ),
        summary(
          "rec-l2",
          "Interest accrual differences are day-count basis.",
          "2026-08-11T00:00:00Z",
        ),
      ],
      "reconciliation/lessons/loan_ops": new Error("ThrottlingException"),
    });

    const resp = await get();
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.map((r: { id: string }) => r.id)).toEqual(["rec-l1", "rec-l2"]);
    for (const record of body) expect(record.domain).toBe("lending");
    expect(agentcoreSend).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("loan_ops"),
      "ThrottlingException",
    );
    warn.mockRestore();
  });

  it("falls back to the default domain when the ledger has no lessons yet", async () => {
    ddbSend.mockResolvedValue({ Items: [] });
    retrieveByNamespace({});

    const body = await (await get()).json();
    expect(body).toEqual([]);
    expect(agentcoreSend).toHaveBeenCalledTimes(1);
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Retrieve",
      namespace: "reconciliation/lessons/lending",
      searchCriteria: { searchQuery: "lending", topK: 25 },
    });
  });

  it("500s with the raw message when the ledger scan itself fails", async () => {
    ddbSend.mockRejectedValue(
      new Error("ResourceNotFoundException: recon-lessons-test"),
    );
    const resp = await get();
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({
      error: "ResourceNotFoundException: recon-lessons-test",
    });
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before touching AWS", async () => {
    authorizeRequest.mockResolvedValue({
      ok: false,
      status: 401,
      message: "missing or malformed Authorization: Bearer <token> header",
    });
    const resp = await get();
    expect(resp.status).toBe(401);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("answers an empty list without touching AWS when RECON_MEMORY_ID is unset", async () => {
    // Re-imported with the variable cleared, so the case holds whether the route reads the id when
    // the module loads or when the request arrives.
    vi.resetModules();
    env.set({ RECON_MEMORY_ID: "" });
    const fresh = await import("@/app/api/recon/memory/route");
    const resp = await fresh.GET(
      jsonRequest("GET", "http://x/api/recon/memory"),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual([]);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(agentcoreSend).not.toHaveBeenCalled();
  });
});
