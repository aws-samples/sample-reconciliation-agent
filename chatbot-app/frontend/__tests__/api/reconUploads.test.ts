// @vitest-environment node
/**
 * The upload route.
 *
 * The environment pragma above is not optional and is not just the house style for API tests. The
 * suite defaults to jsdom, whose `FormData` and `File` are DOM implementations, while `Request`
 * comes from undici -- so `req.formData()` never resolves and every case here fails as a five
 * second timeout with no indication that the environment is the cause.
 */

import { marshall } from "@aws-sdk/util-dynamodb";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const s3Send = vi.fn();
const ddbSend = vi.fn();
const lambdaSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  CopyObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

// The route writes the audit row through this. Without the mock, vitest loads the real client and
// the first `send` reaches AWS -- which in CI has no credentials, so the failure arrives as a
// credential-provider timeout tens of seconds later rather than as a test assertion.
//
// Every command `uploadRecord` imports has to appear here. A factory replaces the whole module, so
// an omitted export arrives as `undefined` and `new PutItemCommand(...)` fails with "not a
// constructor" -- from inside `putSubmission`, which the route then reports as a 400 on a
// submission that was perfectly valid.
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = ddbSend;
  },
  PutItemCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateItemCommand: class {
    constructor(public input: unknown) {}
  },
  QueryCommand: class {
    constructor(public input: unknown) {}
  },
  GetItemCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Pass-through, not a stub: the route builds real attribute-value shapes and the assertions below
// read them back. Marshalling them for real is what makes those assertions meaningful.
vi.mock("@aws-sdk/util-dynamodb", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/util-dynamodb")>(
    "@aws-sdk/util-dynamodb",
  );
  return actual;
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = lambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Typed to accept the request even though no case inspects it, because the module under test calls
// the gate with one and `vi.fn(async () => ...)` would infer a zero-argument signature.
const requireReconAdmin = vi.fn(async (_req: Request) => ({ actor: "tester" }));
vi.mock("@/lib/reconAdmin", () => ({
  requireReconAdmin: (req: Request) => requireReconAdmin(req),
}));

// None of these four has a default anywhere in the code under test, and the route throws without
// them. Set once here rather than in `beforeEach` because nothing under test unsets them.
process.env.IDP_INPUT_BUCKET = "idp-unified-input-test";
process.env.UPLOAD_STAGING_BUCKET = "recon-dev-assets";
process.env.UPLOADS_TABLE = "recon-dev-idp-uploads";
process.env.EMAIL_PREPROCESS_FUNCTION = "recon-dev-email-preprocess";

// Imported AFTER the mocks above, and with a top-level `await` rather than a static import,
// because a static import is hoisted above the `vi.mock` calls and the route would capture the
// real clients.
const { POST } = await import("@/app/api/recon/uploads/route");

function form(
  files: Array<{ name: string; body: string }>,
  fields: Record<string, string>,
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const f of files) fd.append("files", new File([f.body], f.name));
  return new Request("http://localhost/api/recon/uploads", {
    method: "POST",
    body: fd,
  });
}

beforeEach(() => {
  s3Send.mockReset().mockResolvedValue({});
  requireReconAdmin.mockReset().mockResolvedValue({ actor: "tester" });
  // Every DynamoDB call answers with a row containing the submission's files, because
  // `markFileStatus` reads before it writes and throws on a row it cannot find. A bare `{}` here
  // would make every per-file status update fail with "no submission ... to update".
  ddbSend.mockReset().mockImplementation(async () => ({
    Item: marshall({
      submission_id: "sub-1",
      route: "extraction",
      uploaded_at: "2026-09-02T12:00:00Z",
      files: [
        {
          filename: "Notice.pdf",
          object_key: "",
          status: "PENDING",
          size_bytes: 8,
        },
        {
          filename: "good.pdf",
          object_key: "",
          status: "PENDING",
          size_bytes: 8,
        },
        {
          filename: "bad.exe",
          object_key: "",
          status: "PENDING",
          size_bytes: 2,
        },
        {
          filename: "thread.msg",
          object_key: "",
          status: "PENDING",
          size_bytes: 4,
        },
      ],
    }),
  }));
  lambdaSend.mockReset();
});

describe("POST /api/recon/uploads", () => {
  it("writes the audit row before it puts anything", async () => {
    await POST(
      form([{ name: "Notice.pdf", body: "%PDF-1.4" }], {
        route: "extraction",
        configVersion: "Recon-IDP",
      }),
    );
    // The order is the assertion. A crash between the row and the put must leave a visible
    // PENDING row, not an object in a bucket recon has no record of sending -- and for the
    // extraction route that object is already being processed by the time anyone looks.
    expect(ddbSend.mock.invocationCallOrder[0]).toBeLessThan(
      s3Send.mock.invocationCallOrder[0],
    );
  });

  it("rejects one file without failing the rest of the submission", async () => {
    const res = await POST(
      form(
        [
          { name: "good.pdf", body: "%PDF-1.4" },
          { name: "bad.exe", body: "MZ" },
        ],
        { route: "extraction", configVersion: "Recon-IDP" },
      ),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      body.files.map((f: { filename: string }) => [f.filename, f]),
    );
    expect(byName["good.pdf"].status).toBe("UPLOADED");
    expect(byName["bad.exe"].status).toBe("FAILED");
    expect(byName["bad.exe"].error).toMatch(/\.exe/);
  });

  it("returns the gate's response unchanged when the caller is not an admin", async () => {
    requireReconAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "no" }, { status: 403 }),
    } as never);
    const res = await POST(
      form([{ name: "Notice.pdf", body: "%PDF-1.4" }], {
        route: "extraction",
        configVersion: "Recon-IDP",
      }),
    );
    expect(res.status).toBe(403);
    // Nothing was staged. A gate that returns 403 after the put has already happened is not a
    // gate; the object would be in the destination bucket and already extracted.
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("marks a knowledge-base file PENDING_INGESTION, not UPLOADED", async () => {
    // The distinction is the whole reason that status exists: the object is in the bucket, and
    // the corpus does not contain it until an ingestion job has run.
    const res = await POST(
      form([{ name: "good.pdf", body: "%PDF-1.4" }], {
        route: "knowledge-base",
        docType: "email",
      }),
    );
    const body = await res.json();
    expect(body.files[0].status).toBe("PENDING_INGESTION");
  });

  it("invokes the pre-processor for a .msg and uploads the parts it returns", async () => {
    lambdaSend.mockResolvedValue({
      Payload: Buffer.from(
        JSON.stringify({
          error: "",
          parts: [
            {
              kind: "body",
              key: "uploads/derived/x/00-thread.pdf",
              filename: "thread.pdf",
              content_type: "application/pdf",
              attachment_format: "",
              subject: "Fee query",
              sender: "ops@example-counterparty.test",
              recipients: ["recon@example-agent.test"],
              message_id: "<m@x.test>",
              received_date: "2026-09-02T09:15:00Z",
            },
            {
              kind: "attachment",
              key: "uploads/derived/x/01-notice.pdf",
              filename: "notice.pdf",
              content_type: "application/pdf",
              attachment_format: "pdf",
              subject: "Fee query",
              sender: "ops@example-counterparty.test",
              recipients: ["recon@example-agent.test"],
              message_id: "<m@x.test>",
              received_date: "2026-09-02T09:15:00Z",
            },
          ],
        }),
      ),
    });

    const res = await POST(
      form([{ name: "thread.msg", body: "msg!" }], {
        route: "extraction",
        configVersion: "Recon-IDP",
      }),
    );
    const body = await res.json();

    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const copies = s3Send.mock.calls.filter(
      (call) => call[0].constructor.name === "CopyObjectCommand",
    );
    expect(copies).toHaveLength(2);
    // One picked file, one row. `object_key` is the staged `.msg` -- a real object the operator
    // can go and look at -- and the parts it became are listed separately.
    expect(body.files).toHaveLength(1);
    expect(body.files[0].object_key).toMatch(
      /uploads\/inbox\/.*\/thread\.msg$/,
    );
    expect(body.files[0].derived_object_keys).toEqual([
      "thread.pdf",
      "notice.pdf",
    ]);
  });

  it("refuses the whole submission when two files share a name", async () => {
    // The one refusal that is not per-file, because the route cannot say which of the two it
    // dropped.
    const res = await POST(
      form(
        [
          { name: "Notice.pdf", body: "%PDF-1.4" },
          { name: "Notice.pdf", body: "%PDF-1.4" },
        ],
        { route: "extraction", configVersion: "Recon-IDP" },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Notice\.pdf/);
    expect(
      s3Send.mock.calls.filter(
        (call) => call[0].constructor.name === "PutObjectCommand",
      ),
    ).toHaveLength(0);
  });
});

describe("GET /api/recon/uploads", () => {
  it("returns submissions newest-first and applies the same gate", async () => {
    const { GET } = await import("@/app/api/recon/uploads/route");
    ddbSend.mockResolvedValue({
      Items: [
        {
          submission_id: { S: "sub-2" },
          route: { S: "knowledge-base" },
          uploaded_at: { S: "2026-09-02T12:00:00Z" },
          files: { L: [] },
        },
      ],
    });
    const res = await GET(
      new Request("http://localhost/api/recon/uploads?limit=5"),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.submissions[0].submission_id).toBe("sub-2");
  });

  it("caps an absurd limit rather than trusting the query string", async () => {
    const { GET } = await import("@/app/api/recon/uploads/route");
    ddbSend.mockResolvedValue({ Items: [] });
    await GET(new Request("http://localhost/api/recon/uploads?limit=100000"));
    // The Limit that reached DynamoDB, not the one the caller asked for. An unbounded query is a
    // way for one request to read the whole table.
    const sent = JSON.stringify(ddbSend.mock.calls[0][0]);
    expect(sent).toContain('"Limit":100');
  });
});
