/**
 * The bulk extraction route over the REAL reader, for the one answer that reaches the operator as
 * prose.
 *
 * `__tests__/api/idpExtraction.test.ts` stubs `@/lib/noticeExtraction` — correctly, because what it
 * tests is the route's own edges (key handling, status codes, per-key reasons surviving the response).
 * That stub is also why nothing there can catch the bug this file guards: the sentence the Documents
 * tab prints for a document that never became a notice is composed inside the reader, so a stubbed
 * reader will happily return whatever the test hands it.
 *
 * Here the AWS client is the only thing mocked, so a stored row goes in and the response body the page
 * fetches comes out. One case, end to end: a tracking-only row (`record_kind == "document"`) must be
 * reported with its OWN `notice_failure_reason` in `failed`, and never with the migration sentence
 * that used to be returned for any row lacking `idp_sections`.
 */
// @vitest-environment node
import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = send;
  },
  GetItemCommand: class {
    constructor(public input: unknown) {}
  },
  BatchGetItemCommand: class {
    constructor(public input: unknown) {}
  },
}));

const TABLE = "recon-dev-notices";
// The reader has no default for this and throws without it.
process.env.NOTICES_TABLE = TABLE;

const { POST } = await import("@/app/api/recon/idp-extractions/route");

/** A POST to the bulk route carrying `body`. */
function post(body: unknown): Request {
  return new Request("http://localhost/api/recon/idp-extractions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  send.mockReset();
});

describe("POST /api/recon/idp-extractions over the real reader", () => {
  it("answers a tracking-only row with the reason recon stored on it", async () => {
    send.mockResolvedValue({
      Responses: {
        [TABLE]: [
          marshall({
            notice_id: "idp-in/fax-cover.pdf",
            record_kind: "document",
            notice_failure_reason: "extracted no notice_date",
          }),
        ],
      },
    });
    const res = await POST(post({ objectKeys: ["in/fax-cover.pdf"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // In `failed`, not in `extractions` as an empty list: the tab would otherwise show blank field
    // columns for the document with nothing anywhere to say why.
    expect(body.extractions).toEqual({});
    expect(body.failed["in/fax-cover.pdf"]).toBe(
      "recon mapped no notice from this document: extracted no notice_date",
    );
    // The sentence the console used to print for this exact row. Every clause of it was false: the
    // document was extracted the same day, and re-uploading it yields the same unmappable document.
    expect(body.failed["in/fax-cover.pdf"]).not.toMatch(/re-uploading/i);
  });
});
