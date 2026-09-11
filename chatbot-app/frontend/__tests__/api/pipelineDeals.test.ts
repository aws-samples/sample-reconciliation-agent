// @vitest-environment node
/**
 * `/api/pipeline/deals/[id]` and its approve / reject / csv actions.
 *
 * The edit contract is the one most worth pinning: a PATCH must be validated against the OMS
 * formats and refused whole with per-field problems, and a successful edit must regenerate the
 * staging CSV in S3 before the record changes — the CSV is what the OMS validates. The approve
 * contract is the demo's pivot: APPROVED, a synchronous Lambda call, and whatever verdict came back
 * ends up on the deal whether or not the Lambda wrote it itself.
 *
 * Every status transition is a conditional write on the status the route read, so the fake table
 * below evaluates `#status = :expected` and throws DynamoDB's `ConditionalCheckFailedException`
 * when it does not hold. The race tests use `afterGet` to change the row between a route's read and
 * its write — the interleaving a second reviewer, a stale tab or the OMS Lambda produces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

process.env.AWS_REGION = "us-east-1";
process.env.PIPELINE_ASSETS_BUCKET = "test-assets";
process.env.DEALS_TABLE = "test-deals";
process.env.OMS_UPLOAD_FUNCTION = "test-oms-upload";

const ddbSend = vi.fn();
const s3Send = vi.fn();
const lambdaSend = vi.fn();
const requireActor = vi.fn();
const requirePipelineAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/pipelineAdmin", () => ({ requirePipelineAdmin }));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "GetItem", ...i })),
  PutItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "PutItem", ...i })),
  ScanCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Scan", ...i })),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "GetObject", ...i })),
  PutObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "PutObject", ...i })),
  ListObjectsV2Command: vi.fn().mockImplementation((i) => ({ __cmd: "List", ...i })),
  DeleteObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Delete", ...i })),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSend })),
  InvokeCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Invoke", ...i })),
}));

const { emptyFields, toCsv } = await import("@/lib/pipeline/omsSchema");
const deals = await import("@/app/api/pipeline/deals/route");
const dealById = await import("@/app/api/pipeline/deals/[id]/route");
const csv = await import("@/app/api/pipeline/deals/[id]/csv/route");
const approve = await import("@/app/api/pipeline/deals/[id]/approve/route");
const reject = await import("@/app/api/pipeline/deals/[id]/reject/route");
const { toUploadResult } = await import("@/lib/pipeline/server/dealStore");
type DealRecord = import("@/lib/pipeline/types").DealRecord;

/** In-memory deals table behind the DynamoDB mock. */
let table: Record<string, DealRecord>;
/** Runs after the n-th GetItem (1-based) has been served — a concurrent writer between read and write. */
let afterGet: ((n: number) => void) | null;

interface FakePut {
  __cmd: string;
  Key?: never;
  Item?: never;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: never;
}

/** The one condition shape the deal store uses: `#status = :expected` against the stored row. */
function conditionHolds(cmd: FakePut, current: DealRecord | undefined): boolean {
  if (!cmd.ConditionExpression) return true;
  expect(cmd.ConditionExpression).toBe("#status = :expected");
  const attr = cmd.ExpressionAttributeNames!["#status"] as keyof DealRecord;
  const expected = unmarshall(cmd.ExpressionAttributeValues!)[":expected"];
  return current?.[attr] === expected;
}

function installTable() {
  table = {};
  afterGet = null;
  let gets = 0;
  ddbSend.mockImplementation(async (cmd: FakePut) => {
    if (cmd.__cmd === "GetItem") {
      const key = unmarshall(cmd.Key!).deal_id as string;
      const snapshot = table[key] ? marshall(table[key], { removeUndefinedValues: true }) : undefined;
      afterGet?.(++gets);
      return { Item: snapshot };
    }
    if (cmd.__cmd === "PutItem") {
      const item = unmarshall(cmd.Item!) as DealRecord;
      if (!conditionHolds(cmd, table[item.deal_id])) {
        throw Object.assign(new Error("The conditional request failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      table[item.deal_id] = item;
      return {};
    }
    if (cmd.__cmd === "Scan") {
      return { Items: Object.values(table).map((i) => marshall(i, { removeUndefinedValues: true })) };
    }
    throw new Error(`unexpected ${cmd.__cmd}`);
  });
}

/** The `:expected` status each conditional PutItem so far was guarded on, in order. */
function expectedStatuses(): string[] {
  return ddbSend.mock.calls
    .map((c) => c[0] as FakePut)
    .filter((c) => c.__cmd === "PutItem")
    .map((c) => unmarshall(c.ExpressionAttributeValues!)[":expected"] as string);
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

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function patch(id: string, body: unknown) {
  return dealById.PATCH(
    new Request(`http://x/api/pipeline/deals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(id),
  );
}
function approvePost(id: string) {
  return approve.POST(
    new Request(`http://x/api/pipeline/deals/${id}/approve`, { method: "POST" }),
    params(id),
  );
}
function rejectPost(id: string, body: unknown) {
  return reject.POST(
    new Request(`http://x/api/pipeline/deals/${id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(id),
  );
}
const lambdaPayload = (result: unknown) => ({
  Payload: new TextEncoder().encode(JSON.stringify(result)),
});

beforeEach(() => {
  vi.clearAllMocks();
  installTable();
  table.dl_1 = stagedDeal();
  s3Send.mockResolvedValue({});
  requireActor.mockResolvedValue({ actor: "reviewer" });
  requirePipelineAdmin.mockResolvedValue({ actor: "admin-1" });
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

  it("refuses unknown keys and non-string values rather than dropping them", async () => {
    expect((await patch("dl_1", { fields: { issue_size: "1.000" } })).status).toBe(400);
    expect((await patch("dl_1", { fields: { issue_size_mm: 1 } })).status).toBe(400);
    expect((await patch("dl_1", { fields: {} })).status).toBe(400);
    expect((await patch("dl_1", {})).status).toBe(400);
  });

  it("merges a partial edit, regenerates the CSV, records EDITED, and reopens a failed upload", async () => {
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
    });
    expect(resp.status).toBe(200);
    const deal = (await resp.json()) as DealRecord;

    expect(deal.fields.covenant_status_num).toBe("3");
    expect(deal.fields.left_agent).toBe("Silverline");
    expect(deal.fields.issue_size_mm).toBe("500.000"); // untouched fields survive the merge
    expect(deal.status).toBe("STAGED");
    expect(deal.upload).not.toBeNull(); // the failed verdict stays visible for the diff
    const last = deal.history[deal.history.length - 1];
    expect(last).toMatchObject({ action: "EDITED", actor: "admin-1" });
    expect(last.detail).toContain("covenant_status_num");
    expect(last.detail).toContain("left_agent");

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
    expect(s3Send.mock.invocationCallOrder[0]).toBeLessThan(
      ddbSend.mock.invocationCallOrder[ddbSend.mock.calls.length - 1],
    );
    expect(table.dl_1.status).toBe("STAGED");
  });

  it("keeps opportunity_name in step with the edited field", async () => {
    const resp = await patch("dl_1", { fields: { opportunity_name: "Copperfield TLB" } });
    expect((await resp.json()).opportunity_name).toBe("Copperfield TLB");
  });

  it("409s an UPLOADED or REJECTED deal", async () => {
    table.dl_1 = stagedDeal({ status: "UPLOADED" });
    expect((await patch("dl_1", { fields: { notes: "x" } })).status).toBe(409);
    table.dl_1 = stagedDeal({ status: "REJECTED" });
    expect((await patch("dl_1", { fields: { notes: "x" } })).status).toBe(409);
  });

  it("409s when the deal moved on between the read and the write, and puts the CSV back in step with the row that won", async () => {
    // A second reviewer rejects the deal while this PATCH is between its GetItem and its PutItem.
    afterGet = () => {
      table.dl_1 = {
        ...table.dl_1,
        status: "REJECTED",
        history: [...table.dl_1.history, { at: "t", actor: "admin-2", action: "REJECTED", detail: "dup" }],
      };
    };
    const resp = await patch("dl_1", { fields: { left_agent: "Silverline" } });
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/changed while this edit was in flight/);

    // The rejection stands; the edit was not recorded over it.
    expect(table.dl_1.status).toBe("REJECTED");
    expect(table.dl_1.fields.left_agent).toBe("Silverline Partners");
    expect(expectedStatuses()).toEqual(["STAGED"]);
    // The CSV had already been rewritten from the edit; the last write restores the winning row's.
    const puts = s3Send.mock.calls.filter((c) => c[0].__cmd === "PutObject");
    expect(puts).toHaveLength(2);
    expect(puts[1][0].Body).toBe(toCsv(table.dl_1.fields));
  });

  it("404s an unknown deal and honours the admin gate", async () => {
    expect((await patch("dl_9", { fields: { notes: "x" } })).status).toBe(404);
    ddbSend.mockClear();
    const { NextResponse } = await import("next/server");
    requirePipelineAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "not an admin" }, { status: 403 }),
    });
    expect((await patch("dl_1", { fields: { notes: "x" } })).status).toBe(403);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("GET /api/pipeline/deals/[id]/csv", () => {
  it("serves the current fields as a CSV download", async () => {
    const resp = await csv.GET(new Request("http://x/api/pipeline/deals/dl_1/csv"), params("dl_1"));
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

    // Both writes were guarded on the status they followed from, and the read-back after the
    // Lambda was strongly consistent (the first read, before any write of ours, need not be).
    expect(expectedStatuses()).toEqual(["STAGED", "APPROVED"]);
    const gets = ddbSend.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === "GetItem");
    expect(gets).toHaveLength(2);
    expect(gets[0].ConsistentRead).toBeUndefined();
    expect(gets[1].ConsistentRead).toBe(true);
  });

  it("409s and never invokes the OMS when another decision lands between the read and the APPROVED write", async () => {
    afterGet = () => {
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
    afterGet = (n) => {
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
    const { NextResponse } = await import("next/server");
    requirePipelineAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "not an admin" }, { status: 403 }),
    });
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
    afterGet = () => {
      table.dl_1 = { ...table.dl_1, status: "UPLOADED" };
    };
    const resp = await rejectPost("dl_1", { reason: "too late" });
    expect(resp.status).toBe(409);
    expect(table.dl_1.status).toBe("UPLOADED");
    expect(table.dl_1.history.map((h) => h.action)).toEqual(["STAGED"]);
  });
});
