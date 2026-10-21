// @vitest-environment node
/**
 * `/api/pipeline/deals/[id]` and its approve / reject / csv actions.
 *
 * The override contract is the one most worth pinning: every changed field needs a reason, the
 * changed values are validated against the OMS formats and refused whole with per-field problems,
 * a successful override regenerates the staging CSV in S3 before the record changes — the CSV is
 * what the OMS validates — and each override reaches the knowledge memory as a lesson only after the
 * deal kept it. The approve contract is the demo's pivot: APPROVED, a synchronous Lambda call, and
 * whatever verdict came back ends up on the deal whether or not the Lambda wrote it itself.
 *
 * Every write is conditional on the row the route read — its status, and for overrides and
 * decisions its `updated_at` — so the fake table evaluates those conditions and throws DynamoDB's
 * `ConditionalCheckFailedException` when they do not hold. The race tests use `afterGet` to change
 * the row between a route's read and its write — the interleaving a second reviewer, a stale tab or
 * the OMS Lambda produces.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import { agentCoreModule, dynamoDbModule, lambdaModule, s3Module } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { createFakeTable, type FakeDdbCommand } from "../helpers/fakeDdb";
import { admitted, refused } from "../helpers/gates";
import { jsonRequest, routeParams } from "../helpers/http";

const env = scopedEnv(["KNOWLEDGE_MEMORY_ID"], {
  AWS_REGION: "us-east-1",
  PIPELINE_ASSETS_BUCKET: "test-assets",
  DEALS_TABLE: "test-deals",
  EMAILS_TABLE: "test-emails",
  OMS_UPLOAD_FUNCTION: "test-oms-upload",
});
afterAll(() => env.restore());

const ddbSend = vi.fn();
const s3Send = vi.fn();
const lambdaSend = vi.fn();
const agentcoreSend = vi.fn();
const requireActor = vi.fn();
const requireAppAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/auth/app-admin", () => ({ requireAppAdmin }));
vi.mock("@aws-sdk/client-dynamodb", () => dynamoDbModule(ddbSend));
vi.mock("@aws-sdk/client-s3", () => s3Module(s3Send));
vi.mock("@aws-sdk/client-lambda", () => lambdaModule(lambdaSend));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => agentCoreModule(agentcoreSend));

const { emptyFields, toCsv } = await import("@/lib/pipeline/omsSchema");
const deals = await import("@/app/api/pipeline/deals/route");
const dealById = await import("@/app/api/pipeline/deals/[id]/route");
const csv = await import("@/app/api/pipeline/deals/[id]/csv/route");
const approve = await import("@/app/api/pipeline/deals/[id]/approve/route");
const reject = await import("@/app/api/pipeline/deals/[id]/reject/route");
const { toUploadResult } = await import("@/lib/pipeline/server/dealStore");
const { overridesOf } = await import("@/lib/pipeline/overrides");
type DealRecord = import("@/lib/pipeline/types").DealRecord;

/**
 * In-memory deals table behind the DynamoDB mock; `dealsTable.afterGet` is the concurrent writer.
 * The emails table the override route reads for lesson context is not seeded, so that read finds
 * nothing — the route must cope, and the lesson goes out without the email's subject.
 */
const dealsTable = createFakeTable<DealRecord>({ keyAttr: "deal_id" });
const table = dealsTable.rows;
ddbSend.mockImplementation(dealsTable.send);

/** The `:expected` status each status-guarded PutItem so far was conditioned on, in order. */
function expectedStatuses(): string[] {
  return ddbSend.mock.calls
    .map((c) => c[0] as FakeDdbCommand)
    .filter((c) => c.__cmd === "PutItem" && c.ConditionExpression?.includes("#status"))
    .map((c) => unmarshall(c.ExpressionAttributeValues! as never)[":expected"] as string);
}

/** The CreateEvent inputs sent to the knowledge memory so far. */
function lessons(): { actorId: string; sessionId: string; text: string; metadata: unknown }[] {
  return agentcoreSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c.__cmd === "CreateEvent")
    .map((c) => ({
      actorId: c.actorId,
      sessionId: c.sessionId,
      text: c.payload[0].conversational.content.text,
      metadata: c.metadata,
    }));
}

/** A minimal valid STAGED deal — the required fields filled in the OMS formats. */
function stagedDeal(overrides: Partial<DealRecord> = {}): DealRecord {
  const fields = {
    ...emptyFields(),
    pipeline_type: "Loan",
    opportunity_name: "Copperfield Insurance refinancing TLB",
    date_arrived: "8/13/2026",
    maturity_terms: "7 yr",
    currency: "USD",
    issue_size_mm: "500.000",
    security_type: "Loan",
    fixed_floating: "Floating",
    left_agent: "Silverline Partners",
  };
  return {
    deal_id: "dl_1",
    email_id: "em_1",
    opportunity_name: fields.opportunity_name,
    status: "STAGED",
    fields,
    original_fields: { ...fields },
    evidence: {},
    assumptions: [],
    memory_hits: [],
    skills_used: ["deal-parsing"],
    enrichment: { issuer_match: "Copperfield Insurance", fields_from_security_master: [] },
    csv_key: "deal-csv/dl_1.csv",
    upload: null,
    history: [{ at: "2026-08-13T10:00:00Z", actor: "parser", action: "STAGED" }],
    created_at: "2026-08-13T10:00:00Z",
    updated_at: "2026-08-13T10:00:00Z",
    ...overrides,
  };
}

function patch(id: string, body: unknown) {
  return dealById.PATCH(jsonRequest("PATCH", `http://x/api/pipeline/deals/${id}`, body), routeParams({ id }));
}
function approvePost(id: string) {
  return approve.POST(jsonRequest("POST", `http://x/api/pipeline/deals/${id}/approve`), routeParams({ id }));
}
function rejectPost(id: string, body: unknown) {
  return reject.POST(jsonRequest("POST", `http://x/api/pipeline/deals/${id}/reject`, body), routeParams({ id }));
}
const lambdaPayload = (result: unknown) => ({
  Payload: new TextEncoder().encode(JSON.stringify(result)),
});

beforeEach(() => {
  vi.clearAllMocks();
  dealsTable.reset();
  table.dl_1 = stagedDeal();
  s3Send.mockResolvedValue({});
  agentcoreSend.mockResolvedValue({ event: { eventId: "ev-1" } });
  env.set({ KNOWLEDGE_MEMORY_ID: "deal_pipeline_test_knowledge-abc123" });
  requireActor.mockResolvedValue(admitted("reviewer"));
  requireAppAdmin.mockResolvedValue(admitted("admin-1"));
});

describe("GET /api/pipeline/deals", () => {
  it("lists newest first and honours ?limit", async () => {
    table.dl_2 = stagedDeal({ deal_id: "dl_2", created_at: "2026-08-14T10:00:00Z" });
    const all = await (await deals.GET(new Request("http://x/api/pipeline/deals"))).json();
    expect(all.map((d: DealRecord) => d.deal_id)).toEqual(["dl_2", "dl_1"]);
    const one = await (await deals.GET(new Request("http://x/api/pipeline/deals?limit=1"))).json();
    expect(one.map((d: DealRecord) => d.deal_id)).toEqual(["dl_2"]);
    expect((await deals.GET(new Request("http://x/api/pipeline/deals?limit=0"))).status).toBe(400);
  });
});

describe("PATCH /api/pipeline/deals/[id]", () => {
  it("refuses badly formatted values with per-field problems and writes nothing", async () => {
    const resp = await patch("dl_1", {
      fields: { issue_size_mm: "500", currency: "AUD", covenant_status_num: "7" },
      reasons: { issue_size_mm: "r", currency: "r", covenant_status_num: "r" },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/invalid/);
    expect(Object.keys(body.problems).sort()).toEqual([
      "covenant_status_num",
      "currency",
      "issue_size_mm",
    ]);
    expect(body.problems.issue_size_mm).toMatch(/millions/);
    expect(s3Send).not.toHaveBeenCalled();
    expect(table.dl_1.fields.issue_size_mm).toBe("500.000");
  });

  it("refuses unknown keys, non-string values and malformed reasons rather than dropping them", async () => {
    expect((await patch("dl_1", { fields: { issue_size: "1.000" } })).status).toBe(400);
    expect((await patch("dl_1", { fields: { issue_size_mm: 1 } })).status).toBe(400);
    expect((await patch("dl_1", { fields: {} })).status).toBe(400);
    expect((await patch("dl_1", {})).status).toBe(400);
    const edit = { left_agent: "Silverline" };
    expect((await patch("dl_1", { fields: edit, reasons: ["r"] })).status).toBe(400);
    expect((await patch("dl_1", { fields: edit, reasons: { left_agent: 7 } })).status).toBe(400);
    const stray = await patch("dl_1", { fields: edit, reasons: { left_agent: "r", notes: "r" } });
    expect(stray.status).toBe(400);
    expect((await stray.json()).error).toMatch(/notes.*does not edit/);
    const long = await patch("dl_1", { fields: edit, reasons: { left_agent: "x".repeat(2001) } });
    expect(long.status).toBe(400);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("requires a reason for every field whose value changes, and writes nothing without one", async () => {
    const resp = await patch("dl_1", {
      fields: { left_agent: "Silverline", notes: "launch moved" },
      reasons: { left_agent: "the notice's sign-off names the short form", notes: "   " },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/reason is required.*notes/);
    expect(body.problems).toEqual({ notes: "reason required" });
    expect(s3Send).not.toHaveBeenCalled();
    expect(agentcoreSend).not.toHaveBeenCalled();
    expect(table.dl_1.fields.left_agent).toBe("Silverline Partners");
  });

  it("needs no reason for a field sent with its current value, and 400s a body that changes nothing", async () => {
    const same = await patch("dl_1", { fields: { left_agent: "Silverline Partners" } });
    expect(same.status).toBe(400);
    expect((await same.json()).error).toMatch(/no field changes/);

    const resp = await patch("dl_1", {
      fields: { left_agent: "Silverline Partners", notes: "launch moved" },
      reasons: { notes: "the desk tracks the launch move here" },
    });
    expect(resp.status).toBe(200);
    expect(overridesOf(await resp.json()).map((o) => o.field)).toEqual(["notes"]);
  });

  it("validates only the changed values, so a field the parser left blank does not block an override", async () => {
    table.dl_1 = stagedDeal();
    table.dl_1.fields.maturity_terms = ""; // required, and blank: the OMS will say so on upload
    const resp = await patch("dl_1", {
      fields: { left_agent: "Silverline" },
      reasons: { left_agent: "short form" },
    });
    expect(resp.status).toBe(200);
  });

  it("records one override per changed field, quotes each with its reason in history, and reopens a failed upload", async () => {
    table.dl_1 = stagedDeal({
      status: "UPLOAD_FAILED",
      upload: {
        attempted_at: "2026-08-13T10:05:00Z",
        accepted: false,
        staging_key: null,
        errors: [{ code: "COVENANT_STATUS_REQUIRED", field: "covenant_status_num", message: "m" }],
        validator_version: "1",
      },
    });
    const resp = await patch("dl_1", {
      fields: { covenant_status_num: "3", left_agent: "Silverline" },
      reasons: {
        covenant_status_num: "TLBs with a maintenance covenant carry status 3",
        left_agent: "the desk books the short name",
      },
    });
    expect(resp.status).toBe(200);
    const deal = (await resp.json()) as DealRecord;

    expect(deal.fields.covenant_status_num).toBe("3");
    expect(deal.fields.left_agent).toBe("Silverline");
    expect(deal.fields.issue_size_mm).toBe("500.000"); // untouched fields survive the merge
    expect(deal.status).toBe("STAGED");
    expect(deal.upload).not.toBeNull(); // the failed verdict stays visible for the diff

    // Schema order, not body order: one override per changed column, as `changedKeys` lists them.
    expect(overridesOf(deal).map((o) => o.field)).toEqual(["left_agent", "covenant_status_num"]);
    const [agent, covenant] = overridesOf(deal);
    expect(covenant).toMatchObject({
      field: "covenant_status_num",
      parsed_value: "",
      previous_value: "",
      value: "3",
      reason: "TLBs with a maintenance covenant carry status 3",
      actor: "reviewer",
      stage: "break",
      upload_error_codes: ["COVENANT_STATUS_REQUIRED"],
    });
    expect(covenant.override_id).toMatch(/^ov_/);
    expect(agent).toMatchObject({ field: "left_agent", previous_value: "Silverline Partners", stage: "break" });
    expect(agent.upload_error_codes).toBeUndefined(); // the rejection did not name this field
    expect(covenant.override_id).not.toBe(agent.override_id);

    const last = deal.history[deal.history.length - 1];
    expect(last).toMatchObject({ action: "EDITED", actor: "reviewer" });
    expect(last.detail).toContain('Covenant Status #: (blank) → "3" — TLBs with a maintenance covenant');
    expect(last.detail).toContain('Left Agent: "Silverline Partners" → "Silverline" — the desk books');

    // CSV regenerated at the deal's key from the merged fields, before the record write.
    const put = s3Send.mock.calls[0][0];
    expect(put).toMatchObject({
      __cmd: "PutObject",
      Bucket: "test-assets",
      Key: "deal-csv/dl_1.csv",
      ContentType: "text/csv",
    });
    expect(put.Body).toBe(toCsv(deal.fields));
    expect(put.Body.split("\n")[0]).toContain("Covenant Status #");
    const firstDealPut = ddbSend.mock.calls.findIndex((c) => c[0].__cmd === "PutItem");
    expect(s3Send.mock.invocationCallOrder[0]).toBeLessThan(ddbSend.mock.invocationCallOrder[firstDealPut]);
    expect(table.dl_1.status).toBe("STAGED");
    expect(overridesOf(table.dl_1)).toHaveLength(2);
  });

  it("is open to every pipeline user: the admin gate is not consulted", async () => {
    requireAppAdmin.mockResolvedValue(refused(403, "not an admin"));
    const resp = await patch("dl_1", { fields: { notes: "x" }, reasons: { notes: "desk note" } });
    expect(resp.status).toBe(200);
    expect(requireAppAdmin).not.toHaveBeenCalled();
    expect(overridesOf(table.dl_1)[0].actor).toBe("reviewer");
  });

  it("sends one lesson per override after the deal kept it, and records that it arrived", async () => {
    table.dl_1 = stagedDeal({
      evidence: {
        left_agent: {
          value: "Silverline Partners",
          confidence: "medium",
          excerpt: "Silverline Partners (Left Lead)",
          rule: "left lead is the first bank named",
        },
      },
    });
    agentcoreSend
      .mockResolvedValueOnce({ event: { eventId: "ev-agent" } })
      .mockResolvedValueOnce({ event: { eventId: "ev-notes" } });
    const resp = await patch("dl_1", {
      fields: { left_agent: "Silverline", notes: "x" },
      reasons: { left_agent: "the desk books the short name", notes: "desk note" },
    });
    expect(resp.status).toBe(200);

    const sent = lessons();
    expect(sent).toHaveLength(2);
    expect(sent.every((l) => l.actorId === "deal-desk" && l.sessionId === "override-dl_1")).toBe(true);
    const agentLesson = sent.find((l) => l.text.includes("Field: Left Agent"))!;
    expect(agentLesson.text).toContain('Parser value: "Silverline Partners"');
    expect(agentLesson.text).toContain('Corrected value: "Silverline"');
    expect(agentLesson.text).toContain("Reviewer's reason: the desk books the short name");
    expect(agentLesson.text).toContain("Email text the parser read: Silverline Partners (Left Lead)");
    expect(agentLesson.text).toContain("Rule the parser applied: left lead is the first bank named");
    expect(agentLesson.text).toContain("Pipeline Type = Loan");
    expect(agentLesson.text).not.toContain("Left Agent = "); // the overridden field is not context
    // The provenance the strategy copies onto the record: which override, who, which deal.
    const agentOverride = overridesOf(table.dl_1).find((o) => o.field === "left_agent")!;
    expect(agentLesson.metadata).toEqual({
      override_id: { stringValue: agentOverride.override_id },
      author: { stringValue: "reviewer" },
      deal_id: { stringValue: "dl_1" },
    });

    // Lessons only after the deal write that kept the overrides.
    const firstDealPut = ddbSend.mock.calls.findIndex((c) => c[0].__cmd === "PutItem");
    expect(ddbSend.mock.invocationCallOrder[firstDealPut]).toBeLessThan(agentcoreSend.mock.invocationCallOrder[0]);

    const stored = Object.fromEntries(overridesOf(table.dl_1).map((o) => [o.field, o.memory]));
    expect(Object.values(stored).map((m) => m.status)).toEqual(["sent", "sent"]);
    expect(new Set(Object.values(stored).map((m) => m.event_id))).toEqual(new Set(["ev-agent", "ev-notes"]));
    expect(overridesOf(await resp.json()).every((o) => o.memory.status === "sent")).toBe(true);
  });

  it("keeps the override and says so when the memory is not deployed or refuses the lesson", async () => {
    env.set({ KNOWLEDGE_MEMORY_ID: "" });
    let resp = await patch("dl_1", { fields: { notes: "x" }, reasons: { notes: "desk note" } });
    expect(resp.status).toBe(200);
    expect(agentcoreSend).not.toHaveBeenCalled();
    expect(overridesOf(table.dl_1)[0].memory).toEqual({ status: "off" });

    env.set({ KNOWLEDGE_MEMORY_ID: "deal_pipeline_test_knowledge-abc123" });
    agentcoreSend.mockRejectedValueOnce(new Error("ThrottlingException: slow down"));
    resp = await patch("dl_1", { fields: { notes: "y" }, reasons: { notes: "desk note again" } });
    expect(resp.status).toBe(200);
    const [, second] = overridesOf(table.dl_1);
    expect(second.value).toBe("y");
    expect(second.memory).toEqual({ status: "failed", error: "ThrottlingException: slow down" });
    expect(table.dl_1.fields.notes).toBe("y");
  });

  it("keeps opportunity_name in step with the edited field", async () => {
    const resp = await patch("dl_1", {
      fields: { opportunity_name: "Copperfield TLB" },
      reasons: { opportunity_name: "the desk's naming convention" },
    });
    expect((await resp.json()).opportunity_name).toBe("Copperfield TLB");
  });

  it("409s an UPLOADED or REJECTED deal", async () => {
    table.dl_1 = stagedDeal({ status: "UPLOADED" });
    expect((await patch("dl_1", { fields: { notes: "x" }, reasons: { notes: "r" } })).status).toBe(409);
    table.dl_1 = stagedDeal({ status: "REJECTED" });
    expect((await patch("dl_1", { fields: { notes: "x" }, reasons: { notes: "r" } })).status).toBe(409);
  });

  it("409s when the deal moved on between the read and the write, and puts the CSV back in step with the row that won", async () => {
    // A second reviewer rejects the deal while this PATCH is between its GetItem and its PutItem.
    dealsTable.afterGet = () => {
      table.dl_1 = {
        ...table.dl_1,
        status: "REJECTED",
        history: [...table.dl_1.history, { at: "t", actor: "admin-2", action: "REJECTED", detail: "dup" }],
      };
    };
    const resp = await patch("dl_1", { fields: { left_agent: "Silverline" }, reasons: { left_agent: "r" } });
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/changed while this edit was in flight/);

    // The rejection stands; the edit was not recorded over it, and the memory learned nothing.
    expect(table.dl_1.status).toBe("REJECTED");
    expect(table.dl_1.fields.left_agent).toBe("Silverline Partners");
    expect(expectedStatuses()).toEqual(["STAGED"]);
    expect(agentcoreSend).not.toHaveBeenCalled();
    // The CSV had already been rewritten from the edit; the last write restores the winning row's.
    const puts = s3Send.mock.calls.filter((c) => c[0].__cmd === "PutObject");
    expect(puts).toHaveLength(2);
    expect(puts[1][0].Body).toBe(toCsv(table.dl_1.fields));
  });

  it("409s rather than erase another reviewer's override that landed without changing the status", async () => {
    dealsTable.afterGet = (n) => {
      if (n !== 1) return;
      table.dl_1 = {
        ...table.dl_1,
        fields: { ...table.dl_1.fields, notes: "theirs" },
        updated_at: "2026-08-13T10:01:00Z",
      };
    };
    const resp = await patch("dl_1", { fields: { left_agent: "Silverline" }, reasons: { left_agent: "r" } });
    expect(resp.status).toBe(409);
    expect(table.dl_1.fields.notes).toBe("theirs");
    expect(table.dl_1.fields.left_agent).toBe("Silverline Partners");
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("records the memory outcome on a fresh read when another write lands first, without undoing it", async () => {
    // Between the override's write and the outcome write, another reviewer's override lands.
    const realSend = dealsTable.send;
    let puts = 0;
    ddbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
      const out = await realSend(cmd);
      if (cmd.__cmd === "PutItem" && ++puts === 1) {
        table.dl_1 = {
          ...table.dl_1,
          fields: { ...table.dl_1.fields, notes: "theirs" },
          updated_at: "2026-08-13T11:00:00Z",
        };
      }
      return out;
    });
    try {
      const resp = await patch("dl_1", { fields: { left_agent: "Silverline" }, reasons: { left_agent: "r" } });
      expect(resp.status).toBe(200);
      expect(table.dl_1.fields.notes).toBe("theirs");
      expect(table.dl_1.fields.left_agent).toBe("Silverline");
      expect(overridesOf(table.dl_1)[0].memory).toEqual({ status: "sent", event_id: "ev-1" });
    } finally {
      ddbSend.mockImplementation(dealsTable.send);
    }
  });

  it("404s an unknown deal and honours the access gate", async () => {
    expect((await patch("dl_9", { fields: { notes: "x" }, reasons: { notes: "r" } })).status).toBe(404);
    ddbSend.mockClear();
    requireActor.mockResolvedValue(refused(401, "sign in"));
    expect((await patch("dl_1", { fields: { notes: "x" }, reasons: { notes: "r" } })).status).toBe(401);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("GET /api/pipeline/deals/[id]/csv", () => {
  it("serves the current fields as a CSV download", async () => {
    const resp = await csv.GET(new Request("http://x/api/pipeline/deals/dl_1/csv"), routeParams({ id: "dl_1" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/csv");
    expect(resp.headers.get("Content-Disposition")).toContain('dl_1.csv"');
    expect(await resp.text()).toBe(toCsv(table.dl_1.fields));
  });
});

describe("POST /api/pipeline/deals/[id]/approve", () => {
  const rejection = {
    accepted: false,
    errors: [
      {
        code: "COVENANT_STATUS_REQUIRED",
        field: "covenant_status_num",
        message: "Loan records must carry Covenant Status #",
        hint: "1-4",
      },
      { code: "LEFT_AGENT_UNKNOWN", field: "left_agent", message: "nearest: Silverline" },
    ],
    staging_key: null,
    validator_version: "1.0",
    attempted_at: "2026-08-13T10:05:00Z",
  };

  it("marks APPROVED, invokes the OMS Lambda synchronously, and records the verdict it returned", async () => {
    lambdaSend.mockResolvedValue(lambdaPayload(rejection));
    const resp = await approvePost("dl_1");
    expect(resp.status).toBe(200);
    const deal = (await resp.json()) as DealRecord;

    const invoke = lambdaSend.mock.calls[0][0];
    expect(invoke).toMatchObject({ FunctionName: "test-oms-upload", InvocationType: "RequestResponse" });
    expect(JSON.parse(Buffer.from(invoke.Payload).toString())).toEqual({ deal_id: "dl_1" });

    expect(deal.status).toBe("UPLOAD_FAILED");
    expect(deal.upload?.errors.map((e) => e.code)).toEqual([
      "COVENANT_STATUS_REQUIRED",
      "LEFT_AGENT_UNKNOWN",
    ]);
    expect(deal.upload?.attempted_at).toBe("2026-08-13T10:05:00Z");
    expect(deal.history.map((h) => h.action)).toEqual(["STAGED", "APPROVED", "UPLOAD_REJECTED"]);
    expect(deal.history[1].actor).toBe("admin-1");
    expect(deal.history[2].detail).toContain("LEFT_AGENT_UNKNOWN");
    expect(table.dl_1.status).toBe("UPLOAD_FAILED");

    // Both writes were guarded on the status they followed from, and both reads were strongly
    // consistent.
    expect(expectedStatuses()).toEqual(["STAGED", "APPROVED"]);
    const gets = ddbSend.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === "GetItem");
    expect(gets).toHaveLength(2);
    // Both strongly consistent: the first because the APPROVED write is guarded on the `updated_at`
    // it read, and an override saved a moment earlier moves it inside the lag window.
    expect(gets[0].ConsistentRead).toBe(true);
    expect(gets[1].ConsistentRead).toBe(true);
  });

  it("409s and never invokes the OMS when another decision lands between the read and the APPROVED write", async () => {
    dealsTable.afterGet = () => {
      table.dl_1 = { ...table.dl_1, status: "REJECTED" };
    };
    lambdaSend.mockResolvedValue(lambdaPayload(rejection));
    const resp = await approvePost("dl_1");
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/changed while this request was in flight/);
    expect(lambdaSend).not.toHaveBeenCalled();
    expect(table.dl_1.status).toBe("REJECTED");
  });

  it("returns the Lambda's row, not a second copy, when its write lands between the reload and the fallback write", async () => {
    // The Lambda answers with a verdict but its UpdateItem is still in flight when the BFF reloads
    // (the reload sees APPROVED); it lands just before the BFF's fallback recordUpload.
    lambdaSend.mockResolvedValue(
      lambdaPayload({ accepted: true, errors: [], staging_key: "oms-staging/dl_1.csv" }),
    );
    dealsTable.afterGet = (n) => {
      if (n !== 2) return;
      table.dl_1 = {
        ...table.dl_1,
        status: "UPLOADED",
        upload: {
          attempted_at: "2026-08-13T10:05:00Z",
          accepted: true,
          staging_key: "oms-staging/dl_1.csv",
          errors: [],
          validator_version: "1.0",
        },
        history: [...table.dl_1.history, { at: "t", actor: "oms-upload", action: "UPLOAD_ACCEPTED" }],
      };
    };
    const resp = await approvePost("dl_1");
    expect(resp.status).toBe(200);
    const deal = (await resp.json()) as DealRecord;
    expect(deal.status).toBe("UPLOADED");
    expect(deal.history.map((h) => `${h.action}:${h.actor}`)).toEqual([
      "STAGED:parser",
      "APPROVED:admin-1",
      "UPLOAD_ACCEPTED:oms-upload",
    ]);
    expect(table.dl_1.history).toHaveLength(3);
  });

  it("returns the Lambda's own persisted outcome when it wrote the deal itself", async () => {
    // The mock OMS normally records the verdict; the BFF must then not append a second one.
    lambdaSend.mockImplementation(async () => {
      table.dl_1 = {
        ...table.dl_1,
        status: "UPLOADED",
        upload: {
          attempted_at: "2026-08-13T10:05:00Z",
          accepted: true,
          staging_key: "oms-staging/dl_1.csv",
          errors: [],
          validator_version: "1.0",
        },
        history: [...table.dl_1.history, { at: "t", actor: "oms-upload", action: "UPLOAD_ACCEPTED" }],
      };
      return lambdaPayload({ accepted: true, errors: [], staging_key: "oms-staging/dl_1.csv" });
    });
    const deal = (await (await approvePost("dl_1")).json()) as DealRecord;
    expect(deal.status).toBe("UPLOADED");
    expect(deal.history.map((h) => h.action)).toEqual(["STAGED", "APPROVED", "UPLOAD_ACCEPTED"]);
    expect(deal.history[2].actor).toBe("oms-upload");
  });

  it("answers 502 with the APPROVED deal when the Lambda cannot be invoked", async () => {
    lambdaSend.mockRejectedValue(new Error("AccessDeniedException"));
    const resp = await approvePost("dl_1");
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toMatch(/OMS upload failed/);
    expect(body.deal.status).toBe("APPROVED");
    expect(table.dl_1.status).toBe("APPROVED"); // retryable: approve is allowed from APPROVED

    // ...and the retry's write condition admits APPROVED, so it is not refused as a conflict.
    lambdaSend.mockResolvedValue(lambdaPayload(rejection));
    const retry = await approvePost("dl_1");
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as DealRecord).status).toBe("UPLOAD_FAILED");
    expect(expectedStatuses()).toEqual(["STAGED", "APPROVED", "APPROVED"]);
  });

  it("409s a deal that is already UPLOADED or REJECTED", async () => {
    table.dl_1 = stagedDeal({ status: "UPLOADED" });
    expect((await approvePost("dl_1")).status).toBe(409);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("honours the admin gate", async () => {
    requireAppAdmin.mockResolvedValue(refused(403, "not an admin"));
    expect((await approvePost("dl_1")).status).toBe(403);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("fills in anything the Lambda's verdict omitted", () => {
    const now = new Date("2026-08-13T11:00:00Z");
    expect(toUploadResult({ accepted: true }, now)).toEqual({
      attempted_at: "2026-08-13T11:00:00.000Z",
      accepted: true,
      staging_key: null,
      errors: [],
      validator_version: "unknown",
    });
  });
});

describe("POST /api/pipeline/deals/[id]/reject", () => {
  it("records REJECTED with the reason and actor", async () => {
    const resp = await rejectPost("dl_1", { reason: "duplicate of an existing pipeline row" });
    expect(resp.status).toBe(200);
    const deal = (await resp.json()) as DealRecord;
    expect(deal.status).toBe("REJECTED");
    expect(deal.history[deal.history.length - 1]).toMatchObject({
      action: "REJECTED",
      actor: "admin-1",
      detail: "duplicate of an existing pipeline row",
    });
  });

  it("requires a reason and refuses terminal deals", async () => {
    expect((await rejectPost("dl_1", {})).status).toBe(400);
    table.dl_1 = stagedDeal({ status: "REJECTED" });
    expect((await rejectPost("dl_1", { reason: "again" })).status).toBe(409);
  });

  it("409s instead of overwriting an upload that completed between the read and the write", async () => {
    // Reject lands inside the approve window: the file is already in oms-staging, so a rejection
    // recorded now would say the opposite of what happened.
    dealsTable.afterGet = () => {
      table.dl_1 = { ...table.dl_1, status: "UPLOADED" };
    };
    const resp = await rejectPost("dl_1", { reason: "too late" });
    expect(resp.status).toBe(409);
    expect(table.dl_1.status).toBe("UPLOADED");
    expect(table.dl_1.history.map((h) => h.action)).toEqual(["STAGED"]);
  });
});
