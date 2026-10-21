// @vitest-environment node
/**
 * Override lessons and their provenance: listing, pruning, and retracting.
 *
 * A record an override taught carries that override's id, author and deal (copied by the strategy
 * from the event). The contracts pinned here are the ones pruning depends on: the Memory Manager
 * shows who taught each lesson and from which override; deleting a lesson there marks the override
 * retracted on its deal; and the retract route deletes exactly the records carrying that override's
 * id — for the override's author or an admin, nobody else — while the override and its value stay.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { agentCoreModule, dynamoDbModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { createFakeTable } from "../helpers/fakeDdb";
import { admitted, refused } from "../helpers/gates";
import { jsonRequest, routeParams } from "../helpers/http";

const env = scopedEnv(["KNOWLEDGE_MEMORY_ID"], {
  AWS_REGION: "us-east-1",
  DEALS_TABLE: "test-deals",
});
afterAll(() => env.restore());

const ddbSend = vi.fn();
const agentcoreSend = vi.fn();
const requireActor = vi.fn();
const requireAppAdmin = vi.fn();
const requireAppActor = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/auth/app-admin", () => ({ requireAppAdmin, requireAppActor }));
vi.mock("@aws-sdk/client-dynamodb", () => dynamoDbModule(ddbSend));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => agentCoreModule(agentcoreSend));

const { emptyFields } = await import("@/lib/pipeline/omsSchema");
const memory = await import("@/app/api/pipeline/memory/route");
const retract = await import("@/app/api/pipeline/deals/[id]/overrides/[overrideId]/retract/route");
type DealRecord = import("@/lib/pipeline/types").DealRecord;
type FieldOverride = import("@/lib/pipeline/types").FieldOverride;
type MemoryRecord = import("@/lib/pipeline/types").MemoryRecord;

const NS = "deal-pipeline/edge-cases/deal-desk";

const dealsTable = createFakeTable<DealRecord>({ keyAttr: "deal_id" });
const table = dealsTable.rows;
ddbSend.mockImplementation(dealsTable.send);

/** The knowledge memory's records, as ListMemoryRecords would return them. */
let records: { memoryRecordId: string; content: { text: string }; namespaces: string[]; createdAt: Date; metadata?: Record<string, unknown> }[] = [];

function lesson(id: string, text: string, provenance?: { override_id: string; author: string; deal_id: string }) {
  return {
    memoryRecordId: id,
    content: { text },
    namespaces: [NS],
    createdAt: new Date("2026-10-20T18:39:19Z"),
    metadata: {
      "x-amz-agentcore-memory-recordType": { stringValue: "BASE" },
      ...(provenance
        ? Object.fromEntries(Object.entries(provenance).map(([k, v]) => [k, { stringValue: v }]))
        : {}),
    },
  };
}

/** A fake knowledge memory: ListRecords honours EQUALS_TO metadata filters; BatchDelete removes. */
agentcoreSend.mockImplementation(async (cmd: Record<string, unknown> & { __cmd: string }) => {
  if (cmd.__cmd === "ListRecords") {
    const filters = (cmd.metadataFilters ?? []) as { left: { metadataKey: string }; right: { metadataValue: { stringValue: string } } }[];
    return {
      memoryRecordSummaries: records.filter((r) =>
        filters.every((f) => (r.metadata?.[f.left.metadataKey] as { stringValue?: string } | undefined)?.stringValue === f.right.metadataValue.stringValue),
      ),
    };
  }
  if (cmd.__cmd === "BatchDelete") {
    const ids = (cmd.records as { memoryRecordId: string }[]).map((r) => r.memoryRecordId);
    records = records.filter((r) => !ids.includes(r.memoryRecordId));
    return { successfulRecords: ids.map((memoryRecordId) => ({ memoryRecordId })), failedRecords: [] };
  }
  throw new Error(`unexpected ${cmd.__cmd}`);
});

function override(over: Partial<FieldOverride> = {}): FieldOverride {
  return {
    override_id: "ov_1",
    field: "call_protection",
    parsed_value: "Non-callable for three years",
    previous_value: "Non-callable for three years",
    value: "NC3",
    reason: "The desk books NC<years>.",
    actor: "alice",
    at: "2026-10-20T18:38:00Z",
    stage: "review",
    memory: { status: "sent", event_id: "ev-1" },
    ...over,
  };
}

function deal(over: Partial<DealRecord> = {}): DealRecord {
  const fields = { ...emptyFields(), opportunity_name: "Ridgeline sr secured notes", call_protection: "NC3" };
  return {
    deal_id: "dl_1",
    email_id: "em_1",
    opportunity_name: fields.opportunity_name,
    status: "STAGED",
    fields,
    original_fields: { ...fields, call_protection: "Non-callable for three years" },
    evidence: {},
    assumptions: [],
    memory_hits: [],
    skills_used: [],
    enrichment: { issuer_match: null, fields_from_security_master: [] },
    csv_key: "deal-csv/dl_1.csv",
    upload: null,
    history: [],
    overrides: [override()],
    created_at: "2026-10-20T18:37:00Z",
    updated_at: "2026-10-20T18:38:01Z",
    ...over,
  };
}

const req = (method: string, body?: unknown) => jsonRequest(method, "http://x/api/pipeline/memory", body);
const retractPost = (dealId: string, overrideId: string) =>
  retract.POST(
    jsonRequest("POST", `http://x/api/pipeline/deals/${dealId}/overrides/${overrideId}/retract`),
    routeParams({ id: dealId, overrideId }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  dealsTable.reset();
  table.dl_1 = deal();
  records = [
    lesson("mem-ov", "Call Protection is NC<years>.", { override_id: "ov_1", author: "alice", deal_id: "dl_1" }),
    lesson("mem-hand", "Project-finance TLBs are First Lien."),
  ];
  env.set({ KNOWLEDGE_MEMORY_ID: "deal_pipeline_test_knowledge-abc123" });
  requireActor.mockResolvedValue(admitted("reviewer"));
  requireAppAdmin.mockResolvedValue(admitted("admin-1"));
  requireAppActor.mockResolvedValue(admitted("alice", { isAdmin: false }));
});

describe("GET /api/pipeline/memory", () => {
  it("joins each override lesson to the override that taught it, and leaves other rules alone", async () => {
    const body = (await (await memory.GET(req("GET"))).json()) as MemoryRecord[];
    const ov = body.find((r) => r.id === "mem-ov")!;
    expect(ov.metadata).toEqual({ override_id: "ov_1", author: "alice", deal_id: "dl_1" }); // service keys dropped
    expect(ov.source).toEqual({
      kind: "override",
      override_id: "ov_1",
      author: "alice",
      deal_id: "dl_1",
      field: "call_protection",
      opportunity_name: "Ridgeline sr secured notes",
      reason: "The desk books NC<years>.",
      at: "2026-10-20T18:38:00Z",
    });
    const hand = body.find((r) => r.id === "mem-hand")!;
    expect(hand.source).toBeUndefined();
    expect(hand.metadata).toBeUndefined();
  });

  it("keeps the record's own provenance when the deal it names is gone", async () => {
    delete table.dl_1;
    const body = (await (await memory.GET(req("GET"))).json()) as MemoryRecord[];
    expect(body.find((r) => r.id === "mem-ov")!.source).toEqual({
      kind: "override",
      override_id: "ov_1",
      author: "alice",
      deal_id: "dl_1",
    });
  });
});

describe("DELETE /api/pipeline/memory", () => {
  it("marks the override a deleted lesson came from as retracted, once", async () => {
    const resp = await memory.DELETE(req("DELETE", { ids: ["mem-ov", "mem-hand"] }));
    expect(await resp.json()).toEqual({ deleted: ["mem-ov", "mem-hand"], failed: [], retracted: ["ov_1"], unmarked: [] });
    const o = table.dl_1.overrides![0];
    expect(o.memory).toMatchObject({ status: "retracted", retracted_by: "admin-1" });
    expect(o.value).toBe("NC3"); // the correction to the deal stays
    expect(table.dl_1.fields.call_protection).toBe("NC3");
    expect(table.dl_1.history.at(-1)).toMatchObject({
      action: "LESSON_RETRACTED",
      actor: "admin-1",
      detail: "Call Protection: lesson retracted (1 record deleted)",
    });

    // A second lesson re-extracted from the same override deletes cleanly without a second row.
    records = [lesson("mem-ov-2", "again", { override_id: "ov_1", author: "alice", deal_id: "dl_1" })];
    await memory.DELETE(req("DELETE", { ids: ["mem-ov-2"] }));
    expect(table.dl_1.history.filter((h) => h.action === "LESSON_RETRACTED")).toHaveLength(1);
  });
});

describe("POST /api/pipeline/deals/[id]/overrides/[overrideId]/retract", () => {
  it("lets the override's author delete exactly that override's lesson", async () => {
    const resp = await retractPost("dl_1", "ov_1");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as DealRecord;
    expect(body.overrides![0].memory).toMatchObject({ status: "retracted", retracted_by: "alice", event_id: "ev-1" });
    expect(records.map((r) => r.memoryRecordId)).toEqual(["mem-hand"]); // the hand-saved rule stays

    // Found by provenance, not by similarity: the list was filtered on this override's id.
    const list = agentcoreSend.mock.calls.map((c) => c[0]).find((c) => c.__cmd === "ListRecords");
    expect(list.metadataFilters).toEqual([
      { left: { metadataKey: "override_id" }, operator: "EQUALS_TO", right: { metadataValue: { stringValue: "ov_1" } } },
    ]);
    expect(table.dl_1.overrides![0].memory.status).toBe("retracted");
  });

  it("lets an admin retract anyone's lesson, and refuses everyone else", async () => {
    requireAppActor.mockResolvedValue(admitted("bob", { isAdmin: false }));
    const refusedResp = await retractPost("dl_1", "ov_1");
    expect(refusedResp.status).toBe(403);
    expect(records).toHaveLength(2);

    requireAppActor.mockResolvedValue(admitted("admin-1", { isAdmin: true }));
    expect((await retractPost("dl_1", "ov_1")).status).toBe(200);
    expect(table.dl_1.overrides![0].memory.retracted_by).toBe("admin-1");
  });

  it("refuses when there is nothing to retract, and says why", async () => {
    // No record carries the override yet: still extracting, or it did not generalise.
    records = records.filter((r) => r.memoryRecordId !== "mem-ov");
    let resp = await retractPost("dl_1", "ov_1");
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/extraction takes 1–3 minutes/);
    expect(table.dl_1.overrides![0].memory.status).toBe("sent");

    table.dl_1 = deal({ overrides: [override({ memory: { status: "failed", error: "throttled" } })] });
    resp = await retractPost("dl_1", "ov_1");
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/no lesson to retract \(memory: failed\)/);

    table.dl_1 = deal({ overrides: [override({ memory: { status: "retracted", retracted_by: "alice" } })] });
    expect((await retractPost("dl_1", "ov_1")).status).toBe(409);

    expect((await retractPost("dl_1", "ov_9")).status).toBe(404);
    expect((await retractPost("dl_9", "ov_1")).status).toBe(404);
  });

  it("says the lesson is gone when the deal changes under the bookkeeping twice", async () => {
    // Every put to the deal loses its race: another reviewer keeps saving overrides.
    let n = 0;
    ddbSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "PutItem") {
        table.dl_1 = { ...table.dl_1, updated_at: `2026-10-20T19:00:0${n++}Z` };
      }
      return dealsTable.send(cmd as never);
    });
    try {
      const resp = await retractPost("dl_1", "ov_1");
      expect(resp.status).toBe(409);
      expect((await resp.json()).error).toMatch(/lesson was deleted from memory, but deal dl_1 changed/);
      expect(records.map((r) => r.memoryRecordId)).toEqual(["mem-hand"]);
    } finally {
      ddbSend.mockImplementation(dealsTable.send);
    }
  });

  it("honours the access gate before reading anything", async () => {
    requireAppActor.mockResolvedValue(refused(401, "sign in"));
    expect((await retractPost("dl_1", "ov_1")).status).toBe(401);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(agentcoreSend).not.toHaveBeenCalled();
  });
});
