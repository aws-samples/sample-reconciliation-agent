// @vitest-environment node
/**
 * `/api/pipeline/emails` — the pipeline's trigger.
 *
 * POST is what "Simulate incoming email" calls, so the contract pinned here is the whole chain it
 * starts: a RECEIVED row in the emails table, the raw message in S3, and an asynchronous parser
 * invocation carrying the new id. The 400s matter because the two body shapes are exclusive and a
 * body that quietly picked one would hide a client bug.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

process.env.AWS_REGION = "us-east-1";
process.env.ASSETS_BUCKET = "test-assets";
process.env.EMAILS_TABLE = "test-emails";
process.env.PARSER_FUNCTION = "test-parser";

const ddbSend = vi.fn();
const s3Send = vi.fn();
const lambdaSend = vi.fn();
const requireActor = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
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

const emails = await import("@/app/api/pipeline/emails/route");
const emailById = await import("@/app/api/pipeline/emails/[id]/route");
const reparse = await import("@/app/api/pipeline/emails/[id]/reparse/route");
const { parseCreateEmailBody, MAX_EMAIL_BODY_BYTES, MAX_EMAIL_HEADER_BYTES } = await import(
  "@/lib/pipeline/server/requests"
);

/** In-memory emails table behind the DynamoDB mock. */
let table: Record<string, Record<string, unknown>>;
/** Runs after a GetItem has been served — a concurrent writer between a route's read and its write. */
let afterGet: (() => void) | null;

interface FakePut {
  __cmd: string;
  Key?: never;
  Item?: never;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: never;
}

/** The one condition the email store uses: refuse the put while the stored row is PARSING. */
function conditionHolds(cmd: FakePut, current: Record<string, unknown> | undefined): boolean {
  if (!cmd.ConditionExpression) return true;
  expect(cmd.ConditionExpression).toBe("attribute_not_exists(#status) OR #status <> :parsing");
  const attr = cmd.ExpressionAttributeNames!["#status"];
  const parsing = unmarshall(cmd.ExpressionAttributeValues!)[":parsing"];
  return current?.[attr] === undefined || current[attr] !== parsing;
}

function installTable() {
  table = {};
  afterGet = null;
  ddbSend.mockImplementation(async (cmd: FakePut) => {
    if (cmd.__cmd === "GetItem") {
      const key = unmarshall(cmd.Key!).email_id as string;
      const snapshot = table[key] ? marshall(table[key]) : undefined;
      afterGet?.();
      return { Item: snapshot };
    }
    if (cmd.__cmd === "PutItem") {
      const item = unmarshall(cmd.Item!);
      if (!conditionHolds(cmd, table[item.email_id as string])) {
        throw Object.assign(new Error("The conditional request failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      table[item.email_id as string] = item;
      return {};
    }
    if (cmd.__cmd === "Scan") return { Items: Object.values(table).map((i) => marshall(i)) };
    throw new Error(`unexpected ${cmd.__cmd}`);
  });
}

function post(body: unknown) {
  return emails.POST(
    new Request("http://x/api/pipeline/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  installTable();
  s3Send.mockResolvedValue({});
  lambdaSend.mockResolvedValue({ StatusCode: 202 });
  requireActor.mockResolvedValue({ actor: "reviewer" });
});

describe("parseCreateEmailBody", () => {
  const parse = parseCreateEmailBody;
  it("accepts a sample id", () => {
    expect(parse({ sample_id: "01-x" })).toEqual({ sample_id: "01-x" });
  });
  it("accepts a raw email and trims its fields", () => {
    expect(parse({ raw: { from: " a@b.test ", subject: "S", body: "B" } })).toEqual({
      raw: { from: "a@b.test", to: undefined, cc: undefined, subject: "S", body: "B", sent: undefined },
    });
  });
  it("refuses neither, both, and an incomplete raw", () => {
    expect(() => parse({})).toThrow(/sample_id or raw/);
    expect(() => parse(null)).toThrow(/JSON object/);
    expect(() => parse({ sample_id: "x", raw: { from: "a", subject: "s", body: "b" } })).toThrow(
      /not both/,
    );
    expect(() => parse({ raw: { from: "a", subject: "s" } })).toThrow(/raw\.body/);
    expect(() => parse({ raw: "text" })).toThrow(/raw must be an object/);
    expect(() => parse({ raw: { from: "a", subject: "s", body: "b", sent: "yesterday" } })).toThrow(
      /ISO-8601/,
    );
  });

  it("caps the body at 200 KB of UTF-8, measured in bytes", () => {
    const ok = { from: "a@b.test", subject: "S" };
    expect(parse({ raw: { ...ok, body: "x".repeat(MAX_EMAIL_BODY_BYTES) } })).toBeTruthy();
    expect(() => parse({ raw: { ...ok, body: "x".repeat(MAX_EMAIL_BODY_BYTES + 1) } })).toThrow(
      /raw\.body is larger than 200 KB/,
    );
    // 70k characters is under the cap as a string length but 210 KB on the wire: bytes are what
    // the DynamoDB item limit counts, so bytes are what is capped.
    expect(() => parse({ raw: { ...ok, body: "€".repeat(70_000) } })).toThrow(/200 KB/);
  });

  it("caps every header line at 1 KB", () => {
    const long = "y".repeat(MAX_EMAIL_HEADER_BYTES + 1);
    const base = { from: "a@b.test", subject: "S", body: "B" };
    expect(parse({ raw: { ...base, subject: "y".repeat(MAX_EMAIL_HEADER_BYTES) } })).toBeTruthy();
    expect(() => parse({ raw: { ...base, subject: long } })).toThrow(/raw\.subject is longer than 1024 bytes/);
    expect(() => parse({ raw: { ...base, from: long } })).toThrow(/raw\.from/);
    expect(() => parse({ raw: { ...base, to: long } })).toThrow(/raw\.to/);
    expect(() => parse({ raw: { ...base, cc: long } })).toThrow(/raw\.cc/);
  });
});

describe("POST /api/pipeline/emails", () => {
  it("creates a RECEIVED email from a corpus sample, stores it, and invokes the parser", async () => {
    const resp = await post({ sample_id: "06-bank-notice-copperfield-insurance-tlb" });
    expect(resp.status).toBe(202);
    const email = await resp.json();
    expect(email).toMatchObject({
      status: "RECEIVED",
      source_kind: "bank-notice",
      sample_id: "06-bank-notice-copperfield-insurance-tlb",
      deal_id: null,
      parse: null,
      error: null,
    });
    expect(email.email_id).toMatch(/^em_\d{8}T\d{6}_/);
    expect(email.subject).toContain("Copperfield");
    expect(email.received_at).toBe(email.updated_at);

    // Row persisted under the new id.
    expect(table[email.email_id]).toMatchObject({ status: "RECEIVED" });
    expect(ddbSend.mock.calls[0][0]).toMatchObject({ __cmd: "PutItem", TableName: "test-emails" });

    // Raw copy in S3 at the design's key.
    expect(s3Send.mock.calls[0][0]).toMatchObject({
      __cmd: "PutObject",
      Bucket: "test-assets",
      Key: `emails/${email.email_id}.json`,
      ContentType: "application/json",
    });
    expect(JSON.parse(s3Send.mock.calls[0][0].Body).email_id).toBe(email.email_id);

    // Parser kicked off asynchronously with just the id.
    const invoke = lambdaSend.mock.calls[0][0];
    expect(invoke).toMatchObject({ FunctionName: "test-parser", InvocationType: "Event" });
    expect(JSON.parse(Buffer.from(invoke.Payload).toString())).toEqual({ email_id: email.email_id });
  });

  it("creates a manual email from a raw body, defaulting sent to now", async () => {
    const resp = await post({
      raw: { from: "desk@example-firm.test", subject: "Fwd: new TLB", body: "Launching a $300M TLB." },
    });
    expect(resp.status).toBe(202);
    const email = await resp.json();
    expect(email).toMatchObject({ source_kind: "manual", sample_id: null, to: "" });
    expect(Number.isNaN(Date.parse(email.sent))).toBe(false);
  });

  it("400s a body with neither or both shapes and writes nothing", async () => {
    expect((await post({})).status).toBe(400);
    expect(
      (await post({ sample_id: "x", raw: { from: "a", subject: "s", body: "b" } })).status,
    ).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("400s an oversized body before the S3 copy or the row is written", async () => {
    // The row write would fail on DynamoDB's item limit AFTER the S3 object existed, orphaning it.
    const resp = await post({
      raw: { from: "desk@example-firm.test", subject: "Huge", body: "x".repeat(MAX_EMAIL_BODY_BYTES + 1) },
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/200 KB/);
    expect(s3Send).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("404s an unknown sample id", async () => {
    const resp = await post({ sample_id: "99-no-such-sample" });
    expect(resp.status).toBe(404);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("records PARSE_FAILED and answers 502 when the parser cannot be invoked", async () => {
    // The row must still exist: the Inbox shows the failure and Reparse can retry once the
    // function name or permission is fixed.
    lambdaSend.mockRejectedValue(new Error("ResourceNotFoundException"));
    const resp = await post({ sample_id: "01-news-alert-northwind-addon-tlb" });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toMatch(/parser invoke failed/);
    expect(body.email.status).toBe("PARSE_FAILED");
    expect(table[body.email.email_id].status).toBe("PARSE_FAILED");
  });

  it("honours an authorization refusal", async () => {
    const { NextResponse } = await import("next/server");
    requireActor.mockResolvedValue({
      error: NextResponse.json({ error: "no token" }, { status: 401 }),
    });
    expect((await post({ sample_id: "01-news-alert-northwind-addon-tlb" })).status).toBe(401);
  });
});

describe("GET /api/pipeline/emails and /emails/[id]", () => {
  it("lists newest first and reads one by id", async () => {
    table.em_a = { email_id: "em_a", received_at: "2026-08-10T09:00:00Z", subject: "A" };
    table.em_b = { email_id: "em_b", received_at: "2026-08-11T09:00:00Z", subject: "B" };
    const list = await (await emails.GET(new Request("http://x/api/pipeline/emails"))).json();
    expect(list.map((e: { email_id: string }) => e.email_id)).toEqual(["em_b", "em_a"]);

    const one = await emailById.GET(new Request("http://x/api/pipeline/emails/em_a"), params("em_a"));
    expect((await one.json()).subject).toBe("A");
    const missing = await emailById.GET(new Request("http://x/api/pipeline/emails/em_z"), params("em_z"));
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/pipeline/emails/[id]/reparse", () => {
  it("marks the email PARSING, clears the old error, and re-invokes the parser", async () => {
    table.em_a = {
      email_id: "em_a",
      received_at: "2026-08-10T09:00:00Z",
      status: "PARSE_FAILED",
      error: "model timeout",
      updated_at: "2026-08-10T09:01:00Z",
    };
    const resp = await reparse.POST(
      new Request("http://x/api/pipeline/emails/em_a/reparse", { method: "POST" }),
      params("em_a"),
    );
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ status: "PARSING", error: null });
    expect(table.em_a.status).toBe("PARSING");
    expect(JSON.parse(Buffer.from(lambdaSend.mock.calls[0][0].Payload).toString())).toEqual({
      email_id: "em_a",
    });
    // The PARSING write is guarded so two reparses cannot both start a run.
    const put = ddbSend.mock.calls.map((c) => c[0]).find((c) => c.__cmd === "PutItem");
    expect(put.ConditionExpression).toContain("<> :parsing");
  });

  it("409s while a parser run is already in flight, touching neither the row nor the parser", async () => {
    table.em_a = {
      email_id: "em_a",
      received_at: "2026-08-10T09:00:00Z",
      status: "PARSING",
      error: null,
      updated_at: "2026-08-10T09:01:00Z",
    };
    const resp = await reparse.POST(
      new Request("http://x/api/pipeline/emails/em_a/reparse", { method: "POST" }),
      params("em_a"),
    );
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/already being parsed/);
    expect(ddbSend.mock.calls.some((c) => c[0].__cmd === "PutItem")).toBe(false);
    expect(lambdaSend).not.toHaveBeenCalled();
    expect(table.em_a.updated_at).toBe("2026-08-10T09:01:00Z");
  });

  it("409s when a concurrent reparse won the PARSING write between this one's read and write", async () => {
    // Two tabs both read PARSED; the other tab's put lands first. Ours must not start a second run.
    table.em_a = { email_id: "em_a", received_at: "2026-08-10T09:00:00Z", status: "PARSED", deal_id: "dl_1" };
    afterGet = () => {
      table.em_a = { ...table.em_a, status: "PARSING" };
    };
    const resp = await reparse.POST(
      new Request("http://x/api/pipeline/emails/em_a/reparse", { method: "POST" }),
      params("em_a"),
    );
    expect(resp.status).toBe(409);
    expect(lambdaSend).not.toHaveBeenCalled();
    expect(table.em_a.deal_id).toBe("dl_1"); // the other run's row is untouched by ours
  });

  it("404s an unknown email without invoking anything", async () => {
    const resp = await reparse.POST(
      new Request("http://x/api/pipeline/emails/em_z/reparse", { method: "POST" }),
      params("em_z"),
    );
    expect(resp.status).toBe(404);
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});
