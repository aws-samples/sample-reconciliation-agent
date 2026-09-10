// @vitest-environment node
/**
 * The Documents tab's detail route, now read off recon's own notice row.
 *
 * The substance of this route is a JOIN and a translation, and both fail invisibly:
 *
 *  - a document's sections live in TWO places on the row. `idp_sections` says what was extracted and
 *    `idp_tracking.sections_meta` carries the pipeline's confidence alerts, joined on `section_id`.
 *    `idp_sections` is also the first attribute the writer drops to fit an oversized row under
 *    DynamoDB's item limit, so a section can legitimately exist in only one of them — and an inner join
 *    would drop exactly the alerts an operator opened the panel for.
 *  - the stored alert keys are snake_case and the wire contract is camelCase. A spread would compile,
 *    ship, and render `undefined below undefined`; the page also calls `.toFixed(2)`, so a confidence
 *    that arrived as anything but a number or null throws in the browser.
 *
 * Nothing here derives a confidence or compares one to a threshold. The pipeline's own numbers pass
 * through untouched, precisely so a second implementation cannot disagree with the count in the table.
 */
import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = send;
  },
  GetItemCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

process.env.NOTICES_TABLE = "recon-dev-notices";

const { GET } = await import("@/app/api/recon/idp-documents/[objectKey]/route");

/**
 * A stored row whose two per-section sources overlap only partly.
 *
 * Section `1` is in both, `2` only in the extraction, `9` only in the meta.
 */
function row(): Record<string, unknown> {
  return {
    notice_id: "idp-batch-1/notice.pdf",
    record_kind: "notice",
    source_document: "batch-1/notice.pdf",
    parse_method: "IDP",
    confidence_alert_count: 3,
    idp_execution_arn: "arn:aws:states:us-east-1:1:execution:idp:abc",
    idp_record: "document",
    idp_started_at: "2026-09-07T10:00:00Z",
    idp_sections: [
      { section_id: "1", classification: "paydown_notice", page_ids: [1, 2] },
      { section_id: "2", classification: "cover_letter", page_ids: [3] },
    ],
    idp_tracking: {
      object_status: "COMPLETED",
      workflow_status: "SUCCEEDED",
      config_version: "Recon-IDP",
      page_count: 3,
      evaluation_report_uri: "s3://reports/eval/batch-1.json",
      sections_meta: [
        {
          section_id: "1",
          confidence_threshold_alerts: [
            {
              attribute_name: "PaydownAmount",
              confidence: 0.51,
              confidence_threshold: 0.8,
            },
            // A genuine zero. It must NOT come out as null, and an absent value must not come out as 0.
            {
              attribute_name: "EffectiveDate",
              confidence: 0,
              confidence_threshold: 0.8,
            },
          ],
        },
        {
          section_id: "9",
          confidence_threshold_alerts: [{ attribute_name: "Orphan" }],
        },
      ],
    },
  };
}

/** Call the route for one already-decoded object key. */
async function get(objectKey: string): Promise<Response> {
  return GET(new Request("http://x/"), {
    params: Promise.resolve({ objectKey }),
  });
}

/** The `GetItemCommand` input the store built on its most recent call. */
function lastGet(): Record<string, unknown> {
  return (send.mock.calls.at(-1)![0] as { input: Record<string, unknown> })
    .input;
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ Item: marshall(row()) });
});

describe("GET /api/recon/idp-documents/[objectKey]", () => {
  it("reads the row keyed by the derived notice id", async () => {
    const res = await get("batch-1/notice.pdf");
    expect(res.status).toBe(200);
    const q = lastGet();
    expect(q.TableName).toBe("recon-dev-notices");
    expect(q.Key).toEqual({ notice_id: { S: "idp-batch-1/notice.pdf" } });
  });

  it("does not decode the key a second time", async () => {
    // Next.js has already decoded the segment. Only a key with a literal `%` catches a double decode —
    // ordinary keys survive it, which is why this assertion exists at all.
    await get("odd/100% done.pdf");
    expect(lastGet().Key).toEqual({
      notice_id: { S: "idp-odd/100% done.pdf" },
    });
  });

  it("joins sections_meta onto the extracted sections by section_id", async () => {
    const body = await (await get("batch-1/notice.pdf")).json();
    const one = body.document.Sections.find(
      (s: { Id: string }) => s.Id === "1",
    );
    expect(one.Class).toBe("paydown_notice");
    expect(one.PageIds).toEqual([1, 2]);
    // camelCase on the wire, snake_case in the row. Named, not spread.
    expect(one.ConfidenceThresholdAlerts).toEqual([
      {
        attributeName: "PaydownAmount",
        confidence: 0.51,
        confidenceThreshold: 0.8,
      },
      {
        attributeName: "EffectiveDate",
        confidence: 0,
        confidenceThreshold: 0.8,
      },
    ]);
    // Numbers, not DynamoDB's numeric wrapper: the page calls `.toFixed(2)` on these.
    expect(typeof one.ConfidenceThresholdAlerts[0].confidence).toBe("number");
    expect(typeof one.ConfidenceThresholdAlerts[0].confidenceThreshold).toBe(
      "number",
    );
  });

  it("keeps a section that only the extraction knows about", async () => {
    const body = await (await get("batch-1/notice.pdf")).json();
    const two = body.document.Sections.find(
      (s: { Id: string }) => s.Id === "2",
    );
    expect(two.Class).toBe("cover_letter");
    expect(two.PageIds).toEqual([3]);
    // Null and not `[]`: the pipeline reported no alert field for this section, which is a different
    // statement from "it checked and flagged nothing".
    expect(two.ConfidenceThresholdAlerts).toBeNull();
  });

  it("keeps a section that only sections_meta knows about, with its alerts", async () => {
    // `idp_sections` is the attribute the writer drops first to fit an oversized row, so this is the
    // ordinary case for a large document — and dropping the entry would hide its alerts entirely.
    const body = await (await get("batch-1/notice.pdf")).json();
    const nine = body.document.Sections.find(
      (s: { Id: string }) => s.Id === "9",
    );
    expect(nine).toBeDefined();
    expect(nine.Class).toBeNull();
    expect(nine.PageIds).toBeNull();
    // An absent confidence is null and never 0 — 0 is a real confidence, and `.toFixed(2)` on a
    // manufactured zero would assert something nobody measured.
    expect(nine.ConfidenceThresholdAlerts).toEqual([
      { attributeName: "Orphan", confidence: null, confidenceThreshold: null },
    ]);
  });

  it("carries the header fields and the report pointers", async () => {
    const body = await (await get("batch-1/notice.pdf")).json();
    const d = body.document;
    expect(d.ObjectKey).toBe("batch-1/notice.pdf");
    expect(d.ObjectStatus).toBe("COMPLETED");
    expect(d.ConfigVersion).toBe("Recon-IDP");
    expect(d.PageCount).toBe(3);
    expect(d.ConfidenceAlertCount).toBe(3);
    expect(d.WorkflowExecutionArn).toMatch(/^arn:aws:states:/);
    expect(d.EvaluationReportURI).toBe("s3://reports/eval/batch-1.json");
    // Null rather than absent or `""`: not every configuration writes a summary report.
    expect(d.SummaryReportURI).toBeNull();
    // Human review is absent from the completion event, so the response carries no field for it at all
    // -- not a null one. A null would have invited a renderer to answer a question recon cannot answer.
    expect(Object.keys(d).filter((k) => k.startsWith("HITL"))).toEqual([]);
  });

  it("renders a row that has no tracking snapshot as nulls rather than failing", async () => {
    // Written before the hook captured a snapshot. Every field out of `idp_tracking` is independently
    // nullable so the whole panel degrades instead of the request erroring.
    send.mockResolvedValue({
      Item: marshall({
        notice_id: "idp-bare.pdf",
        source_document: "bare.pdf",
        parse_method: "IDP",
      }),
    });
    const res = await get("bare.pdf");
    expect(res.status).toBe(200);
    const d = (await res.json()).document;
    expect(d.ObjectKey).toBe("bare.pdf");
    expect(d.ObjectStatus).toBeNull();
    expect(d.PageCount).toBeNull();
    expect(d.ConfidenceAlertCount).toBeNull();
    expect(d.Sections).toEqual([]);
  });

  it("answers 404 when recon has no row for the key", async () => {
    // Not an empty success: a panel of blank fields for a mistyped key reads as a document that was
    // processed and produced nothing.
    send.mockResolvedValue({});
    const res = await get("missing.pdf");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/missing\.pdf/);
  });

  it("reports a failed read as 500", async () => {
    send.mockRejectedValue(new Error("dynamodb:GetItem denied"));
    const res = await get("any.pdf");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/dynamodb:GetItem/);
  });
});
