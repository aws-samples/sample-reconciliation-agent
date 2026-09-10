// @vitest-environment node
/**
 * The Documents tab's list route, now a Query against recon's own notice table.
 *
 * What is worth asserting here is everything that fails QUIETLY. This route used to read the extraction
 * pipeline's GraphQL API, where a refused query arrived as HTTP 200 with an `errors` array and every
 * mistake surfaced as "no documents"; a DynamoDB refusal at least throws. The silent failures that
 * remain are all about the PAGE the caller gets:
 *
 *  - `ScanIndexForward` the wrong way round shows the oldest 100 documents under a column header that
 *    says newest first, which reads as "nothing has been processed for weeks";
 *  - a continuation token that loses one of its three key attributes either restarts at page one — which
 *    a paging client follows forever — or resumes at the wrong row;
 *  - a `view` parameter quietly ignored looks like a filter that worked.
 *
 * The DynamoDB client is mocked; the store's own translation is NOT, so these assertions also cover the
 * stored-to-wire mapping the tab renders.
 */
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = send;
  },
  QueryCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  // Unused by this route, but the store imports it and the mock replaces the whole module.
  GetItemCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

// The store has no default for this and throws without it.
process.env.NOTICES_TABLE = "recon-dev-notices";

const listRoute = await import("@/app/api/recon/idp-documents/route");

/** One stored row, in the shape `backend/idp_hook/tracking.py` writes. */
function row(objectKey: string): Record<string, unknown> {
  return {
    notice_id: `idp-${objectKey}`,
    record_kind: "notice",
    source_document: objectKey,
    parse_method: "IDP",
    confidence_alert_count: 2,
    idp_record: "document",
    idp_started_at: "2026-08-25T01:36:12Z",
    idp_tracking: {
      object_status: "COMPLETED",
      workflow_status: "SUCCEEDED",
      initial_event_time: "2026-08-25T01:36:12Z",
      completion_time: "2026-08-25T01:38:09Z",
      config_version: "unapplied-cash-v1",
      evaluation_status: "COMPLETED",
      page_count: 4,
    },
  };
}

/** A GSI `LastEvaluatedKey`: the index's hash and range PLUS the table's own key. */
const LAST_KEY = {
  idp_record: { S: "document" },
  idp_started_at: { S: "2026-08-25T01:36:12Z" },
  notice_id: { S: "idp-a/one.pdf" },
};

/** The `QueryCommand` input the route built on its most recent call. */
function lastQuery(): Record<string, unknown> {
  return (send.mock.calls.at(-1)![0] as { input: Record<string, unknown> })
    .input;
}

/** The key values the route bound into its key condition. */
function lastValues(): Record<string, { S: string }> {
  return lastQuery().ExpressionAttributeValues as Record<string, { S: string }>;
}

/** Call the route with a query string. */
async function get(qs = ""): Promise<Response> {
  return listRoute.GET(new Request(`http://x/api/recon/idp-documents${qs}`));
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
});

describe("GET /api/recon/idp-documents", () => {
  it("returns the rows, a continuation token, and the window it actually used", async () => {
    send.mockResolvedValue({
      Items: [marshall(row("a/one.pdf"))],
      LastEvaluatedKey: LAST_KEY,
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.documents).toHaveLength(1);
    // Translated by the store, not forwarded: the stored attributes are snake_case and nested.
    expect(body.documents[0].ObjectKey).toBe("a/one.pdf");
    expect(body.documents[0].ConfigVersion).toBe("unapplied-cash-v1");
    expect(body.documents[0].PageCount).toBe(4);
    expect(body.documents[0].ConfidenceAlertCount).toBe(2);
    expect(typeof body.nextToken).toBe("string");
    // The echoed window is what lets the tab state the range on screen instead of the range requested.
    expect(typeof body.window.startDateTime).toBe("string");
    expect(typeof body.window.endDateTime).toBe("string");
  });

  it("reads the document index over the requested window, newest first", async () => {
    await get(
      "?startDateTime=2026-08-01T00:00:00Z&endDateTime=2026-09-01T00:00:00Z",
    );
    const q = lastQuery();
    expect(q.TableName).toBe("recon-dev-notices");
    expect(q.IndexName).toBe("idp-document-index");
    expect(q.KeyConditionExpression).toBe(
      "idp_record = :r AND idp_started_at BETWEEN :s AND :e",
    );
    expect(lastValues()).toEqual({
      ":r": { S: "document" },
      ":s": { S: "2026-08-01T00:00:00Z" },
      ":e": { S: "2026-09-01T00:00:00Z" },
    });
    // Newest first. The range key sorts ascending by default, so this is the whole of the tab's claim.
    expect(q.ScanIndexForward).toBe(false);
  });

  it("defaults to a 30-day window when the caller gives none", async () => {
    await get();
    const v = lastValues();
    const span = Date.parse(v[":e"].S) - Date.parse(v[":s"].S);
    expect(span).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -4);
  });

  it("refuses a `view` parameter instead of ignoring it", async () => {
    // Recon records no production/test flag, so there is nothing to filter on. Ignoring the parameter
    // would read as a filter that worked, which is the one outcome nobody can see is wrong.
    const res = await get("?view=TEST");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/production\/test flag/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("clamps an oversized limit and defaults to the same ceiling", async () => {
    await get("?limit=5000");
    expect(lastQuery().Limit).toBe(100);
    await get("?limit=7");
    expect(lastQuery().Limit).toBe(7);
    await get();
    expect(lastQuery().Limit).toBe(100);
  });

  it("rejects a non-integer limit", async () => {
    const res = await get("?limit=abc");
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an unparseable timestamp and an inverted window", async () => {
    expect((await get("?startDateTime=yesterday")).status).toBe(400);
    expect(
      (
        await get(
          "?startDateTime=2026-09-01T00:00:00Z&endDateTime=2026-08-01T00:00:00Z",
        )
      ).status,
    ).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("round-trips a continuation token with all three key attributes intact", async () => {
    // ⚠️ THE paging assertion. A key on a GSI is the index's hash and range plus the table's own key,
    // because the index is not unique. A token that dropped `notice_id` would be rejected outright, and
    // one that kept only the timestamp would resume at whichever row happened to share it.
    send.mockResolvedValue({ Items: [], LastEvaluatedKey: LAST_KEY });
    const first = await (await get()).json();
    // Opaque to the caller, and URL-safe: `+` in a query string is a space, which is exactly the
    // corruption that pages back to the first page forever without ever failing.
    expect(first.nextToken).not.toMatch(/[+/=]/);

    await get(`?nextToken=${encodeURIComponent(first.nextToken)}`);
    expect(lastQuery().ExclusiveStartKey).toEqual(LAST_KEY);
  });

  it("reports an undecodable nextToken as a 400 naming the parameter", async () => {
    // Never a silent restart from page one: a paging client reads the first page arriving again as more
    // results and follows the token round in a circle.
    for (const bad of [
      "not-a-token",
      "e30",
      "W10",
      Buffer.from('"x"').toString("base64url"),
    ]) {
      const res = await get(`?nextToken=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/nextToken/);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failed read as 500, not as an empty list", async () => {
    // 500 and not 502: this is recon's own table, so sending the operator upstream to the document
    // pipeline would waste the one person who could fix it.
    send.mockRejectedValue(
      new Error("User is not authorized to perform: dynamodb:Query"),
    );
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/dynamodb:Query/);
  });

  it("answers an empty index with an empty list and no token", async () => {
    send.mockResolvedValue({});
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.nextToken).toBeNull();
  });

  it("reads a backfilled row's start time off the row, and invents nothing else", async () => {
    // ⚠️ 16 such rows are live. They pre-date the tracking snapshot, so they carry NO `idp_tracking`
    // whatsoever — only the top-level index attributes a backfill wrote. Taking the start time from the
    // snapshot alone returned null for every one of them, which put an em dash in the Started column and
    // left the `≈` marker beside nothing on exactly the rows it exists for. `idp_started_at` is the
    // index's range key, so it is the value these rows were ORDERED by: showing it is what makes their
    // position in the list explainable.
    const backfilled = {
      notice_id: "idp-old/backfilled.pdf",
      record_kind: "notice",
      source_document: "old/backfilled.pdf",
      parse_method: "IDP",
      idp_record: "document",
      idp_started_at: "2026-03-04T00:00:00Z",
      idp_started_at_approximate: true,
    };
    send.mockResolvedValue({ Items: [marshall(backfilled)] });
    const doc = (await (await get()).json()).documents[0];
    expect(doc.InitialEventTime).toBe("2026-03-04T00:00:00Z");
    // And it is marked as derived, which is the whole reason the time may be shown at all.
    expect(doc.idp_started_at_approximate).toBe(true);
    // Everything the snapshot would have carried stays ABSENT. Recon holds no second-hand version of any
    // of these, and a manufactured `ConfigVersion` in particular would claim the row ran under a
    // configuration nobody recorded — the one field the tab's filter reads.
    expect(doc.ConfigVersion).toBeNull();
    expect(doc.ObjectStatus).toBeNull();
    expect(doc.WorkflowStatus).toBeNull();
    expect(doc.EvaluationStatus).toBeNull();
    expect(doc.PageCount).toBeNull();
    expect(doc.CompletionTime).toBeNull();
  });

  it("prefers the observed start time over the row's derived one", async () => {
    // The fallback is a fallback. Where the hook captured a snapshot, that time is the one the pipeline
    // OBSERVED; `idp_started_at` on a backfilled row was derived from the notice's business date.
    const both = row("a/one.pdf");
    both.idp_started_at = "2026-01-01T00:00:00Z";
    (both.idp_tracking as Record<string, unknown>).initial_event_time =
      "2026-08-25T01:36:12Z";
    send.mockResolvedValue({ Items: [marshall(both)] });
    const doc = (await (await get()).json()).documents[0];
    expect(doc.InitialEventTime).toBe("2026-08-25T01:36:12Z");
  });

  it("treats a row written before `record_kind` existed as a notice", async () => {
    // 16 such rows are live. Absence is not a gap to paper over: it is the pre-change history.
    const legacy = row("old/one.pdf");
    delete legacy.record_kind;
    send.mockResolvedValue({ Items: [marshall(legacy)] });
    const body = await (await get()).json();
    expect(body.documents[0].ObjectKey).toBe("old/one.pdf");
    expect(body.documents[0].notice_failure_reason).toBeNull();
  });
});
