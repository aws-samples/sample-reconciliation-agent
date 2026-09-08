import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = send;
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

// The module has no default for this and throws without it. Set once here rather than in
// `beforeEach` because nothing under test ever unsets it.
process.env.UPLOADS_TABLE = "recon-dev-idp-uploads";

const { RECENCY_BUCKET, listRecentSubmissions, markFileStatus, putSubmission } =
  await import("@/lib/uploadRecord");

// Module scope, because two `describe` blocks below use it. Declared inside `putSubmission`'s block
// it would be out of scope in `markFileStatus`'s.
const submission = {
  submission_id: "sub-1",
  workflow_type: "unapplied-cash-notice",
  route: "extraction" as const,
  config_version: "Recon-IDP",
  uploaded_by: "user@example.com",
  files: [
    {
      filename: "a.pdf",
      object_key: "in/a.pdf",
      status: "UPLOADED" as const,
      size_bytes: 12,
    },
  ],
};

beforeEach(() => {
  send.mockReset();
});

describe("putSubmission", () => {
  it("stamps the recency-index partition so the row is queryable in order", async () => {
    send.mockResolvedValue({});
    await putSubmission(submission);
    const item = (
      send.mock.calls[0][0] as {
        input: { Item: Record<string, { S?: string }> };
      }
    ).input.Item;
    expect(item.gsi_bucket.S).toBe(RECENCY_BUCKET);
    expect(item.uploaded_at.S).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a row with no files — an empty submission is a bug, not a submission", async () => {
    await expect(putSubmission({ ...submission, files: [] })).rejects.toThrow(
      /at least one file/,
    );
  });

  it("refuses two files with the same name, because filename is a file's identity here", async () => {
    await expect(
      putSubmission({
        ...submission,
        files: [submission.files[0], submission.files[0]],
      }),
    ).rejects.toThrow(/both named "a\.pdf"/);
  });
});

describe("markFileStatus", () => {
  /** The stored row, marshalled the way DynamoDB returns it, with two files. */
  const storedTwoFiles = {
    Item: marshall({
      ...submission,
      uploaded_at: "2026-09-02T12:00:00Z",
      files: [
        submission.files[0],
        {
          filename: "b.pdf",
          object_key: "in/b.pdf",
          status: "PENDING",
          size_bytes: 9,
        },
      ],
    }),
  };

  it("rewrites only the addressed file, leaving its siblings alone", async () => {
    // Read first, then write. Index 1 is the Update; index 0 is the GetItem.
    send.mockResolvedValueOnce(storedTwoFiles).mockResolvedValueOnce({});
    await markFileStatus({
      submissionId: "sub-1",
      filename: "a.pdf",
      patch: { ...submission.files[0], status: "INGESTED" },
    });
    const input = (send.mock.calls[1][0] as { input: Record<string, unknown> })
      .input;
    expect(input.Key).toEqual({ submission_id: { S: "sub-1" } });
    // Wrapped in a one-key map before unmarshalling. `unmarshall` takes a marshalled ITEM -- a map
    // of name to AttributeValue -- so handing it the bare `{ L: [...] }` for `:files` makes it read
    // "L" as an attribute NAME and throw "Unsupported type passed: L".
    const written = (
      unmarshall({
        files: (input.ExpressionAttributeValues as Record<string, never>)[
          ":files"
        ],
      }) as { files: Array<{ filename: string; status: string }> }
    ).files;
    expect(written).toEqual([
      expect.objectContaining({ filename: "a.pdf", status: "INGESTED" }),
      expect.objectContaining({ filename: "b.pdf", status: "PENDING" }),
    ]);
  });

  it("reads consistently, so a sibling settled a moment ago is not reverted", async () => {
    send.mockResolvedValueOnce(storedTwoFiles).mockResolvedValueOnce({});
    await markFileStatus({
      submissionId: "sub-1",
      filename: "a.pdf",
      patch: { ...submission.files[0], status: "INGESTED" },
    });
    const read = (send.mock.calls[0][0] as { input: Record<string, unknown> })
      .input;
    expect(read.ConsistentRead).toBe(true);
  });

  it("does not touch uploaded_at — that is the recency key, not a heartbeat", async () => {
    send.mockResolvedValueOnce(storedTwoFiles).mockResolvedValueOnce({});
    await markFileStatus({
      submissionId: "sub-1",
      filename: "a.pdf",
      patch: { ...submission.files[0], status: "INGESTED" },
    });
    const input = (send.mock.calls[1][0] as { input: Record<string, unknown> })
      .input;
    expect(input.UpdateExpression).not.toContain("uploaded_at");
    expect(input.UpdateExpression).toContain("status_updated_at");
  });

  it("refuses a submission id that is not there, rather than leaving a file PENDING forever", async () => {
    send.mockResolvedValueOnce({});
    await expect(
      markFileStatus({
        submissionId: "sub-missing",
        filename: "a.pdf",
        patch: submission.files[0],
      }),
    ).rejects.toThrow(/no submission sub-missing to update/);
  });

  it("refuses a filename the submission does not contain", async () => {
    send.mockResolvedValueOnce(storedTwoFiles);
    await expect(
      markFileStatus({
        submissionId: "sub-1",
        filename: "never-uploaded.pdf",
        patch: { ...submission.files[0], filename: "never-uploaded.pdf" },
      }),
    ).rejects.toThrow(/has no file named never-uploaded\.pdf/);
  });
});

describe("listRecentSubmissions", () => {
  it("queries the index newest-first", async () => {
    send.mockResolvedValue({ Items: [] });
    await listRecentSubmissions({ limit: 10 });
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> })
      .input;
    expect(input.IndexName).toBe("by_recency");
    expect(input.ScanIndexForward).toBe(false);
  });

  it("refuses to run with no table name rather than guessing one", async () => {
    // Unset for this test only. A default table name is the failure being prevented: it would let
    // this module read and write some other account's table and report success. The check lives in
    // a function rather than at module load on purpose -- `next build` imports every route module
    // with none of the runtime's environment, so a load-time throw would fail the build instead.
    const saved = process.env.UPLOADS_TABLE;
    delete process.env.UPLOADS_TABLE;
    try {
      await expect(listRecentSubmissions({ limit: 5 })).rejects.toThrow(
        /UPLOADS_TABLE is not set/,
      );
    } finally {
      process.env.UPLOADS_TABLE = saved;
    }
  });

  it("follows the continuation token rather than truncating the list", async () => {
    send
      .mockResolvedValueOnce({
        Items: [{ submission_id: { S: "a" } }],
        LastEvaluatedKey: { submission_id: { S: "a" } },
      })
      .mockResolvedValueOnce({ Items: [{ submission_id: { S: "b" } }] });
    const rows = await listRecentSubmissions({ limit: 50 });
    expect(rows.map((r) => r.submission_id)).toEqual(["a", "b"]);
  });
});
