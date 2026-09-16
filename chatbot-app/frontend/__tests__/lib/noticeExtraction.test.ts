/**
 * Reading a document's extracted fields off recon's own notice row.
 *
 * This module replaced a reader that called the document pipeline's GraphQL API twice per section. The
 * substance of the change is that recon now answers from data it already owns, so the tests worth
 * having are about the answers it has to keep apart:
 *
 *  - no notice row at all — recon never wrote one, which is `UnknownDocumentError` and a 404;
 *  - a row whose per-field detail was dropped to fit DynamoDB's item limit: the notice EXISTS, so this
 *    is `unavailable` with the row's stored sentence, not an absence;
 *  - a tracking-only row (`record_kind == "document"`): the pipeline finished the document but recon
 *    mapped no notice out of it, and the row's own `notice_failure_reason` is the true explanation.
 *    Anything the reader inferred instead would be a guess, and the guess this file used to assert
 *    ("re-uploading the document produces a notice that has it") was wrong on exactly this row;
 *  - a notice row with no `idp_sections` at all: stated without a cause, because the row names none;
 *  - a row with an empty `idp_sections`: the extractor genuinely read nothing, which is `sections: []`
 *    and no reason at all.
 *
 * Collapsing any two of those turns an ordinary outcome into a red failure, hides a real gap, or —
 * the case that reached the deployed console — explains a document with a sentence about a different
 * kind of row entirely.
 */
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
// The module has no default for this and throws without it. Set once here rather than in `beforeEach`
// because only the one test that asserts the throw ever unsets it.
process.env.NOTICES_TABLE = TABLE;

const {
  noticeIdFor,
  readNoticeExtraction,
  readNoticeExtractions,
  UnknownDocumentError,
} = await import("@/lib/noticeExtraction");

/** One stored section, in the shape `backend/idp_hook/mapper.py` writes. */
const SECTION = {
  section_id: "1",
  classification: "LoanPaymentNotice",
  page_ids: [0],
  fields: { BorrowerName: "Cascade Holdings LLC", Amount: "10" },
  confidences: [
    { field: "BorrowerName", confidence: 1.0, threshold: 0.8, extracted: true },
    { field: "Amount", confidence: 0.8, threshold: 0.9, extracted: true },
  ],
  mean_confidence: 0.9,
  alert_count: 1,
};

/**
 * A marshalled notice row.
 *
 * @param objectKey - the document's object key, from which the notice id is derived.
 * @param attrs - the extraction attributes to put on the row.
 * @returns the row as DynamoDB returns it.
 */
function row(objectKey: string, attrs: Record<string, unknown> = {}) {
  return marshall(
    { notice_id: noticeIdFor(objectKey), ...attrs },
    { removeUndefinedValues: true },
  );
}

/** The input of the nth command handed to `send`. */
function inputOf(n: number): Record<string, unknown> {
  return (send.mock.calls[n][0] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  send.mockReset();
});

describe("readNoticeExtraction", () => {
  it("looks the row up by the derived notice id and projects only what it reads", async () => {
    send.mockResolvedValue({
      Item: row("in/a.pdf", { idp_sections: [SECTION] }),
    });
    await readNoticeExtraction({ objectKey: "in/a.pdf" });
    const input = inputOf(0) as {
      TableName: string;
      Key: { notice_id: { S: string } };
      ProjectionExpression: string;
    };
    expect(input.TableName).toBe(TABLE);
    // `idp-` + the key: the id the hook derives, so a re-delivered event overwrites rather than
    // duplicating. Getting this wrong reads as every document being unextracted.
    expect(input.Key.notice_id.S).toBe("idp-in/a.pdf");
    // `notice_id` has to be in the projection even though the caller knows it: it is what makes "the
    // row exists" distinguishable from "the row exists and carries no extraction".
    expect(input.ProjectionExpression).toContain("notice_id");
    expect(input.ProjectionExpression).toContain("idp_sections");
    // And both attributes the tracking-row branch reads. A projected-away attribute is
    // indistinguishable from an absent one, so leaving either out would not fail anywhere -- it would
    // quietly send every tracking row back down the notice path with the wrong sentence attached.
    expect(input.ProjectionExpression).toContain("record_kind");
    expect(input.ProjectionExpression).toContain("notice_failure_reason");
  });

  it("returns the stored sections with no reason attached", async () => {
    send.mockResolvedValue({ Item: row("a.pdf", { idp_sections: [SECTION] }) });
    const got = await readNoticeExtraction({ objectKey: "a.pdf" });
    expect(got.unavailable).toBeNull();
    expect(got.sections).toHaveLength(1);
    expect(got.sections[0].classification).toBe("LoanPaymentNotice");
    expect(got.sections[0].fields.BorrowerName).toBe("Cascade Holdings LLC");
    expect(got.sections[0].confidences[1].field).toBe("Amount");
    expect(got.sections[0].alert_count).toBe(1);
  });

  it("hands the confidences back as numbers, not as the strings DynamoDB stores", async () => {
    // The hook writes Decimals, which DynamoDB stores as `N` -- a STRING on the wire. The panel calls
    // `.toFixed(2)` on these and compares them against thresholds, so a string here would render
    // "0.80000000000000004".toFixed as a crash and compare "0.8" < "0.9" by accident of lexical order.
    send.mockResolvedValue({ Item: row("a.pdf", { idp_sections: [SECTION] }) });
    const [section] = (await readNoticeExtraction({ objectKey: "a.pdf" }))
      .sections;
    expect(typeof section.confidences[0].confidence).toBe("number");
    expect(typeof section.confidences[0].threshold).toBe("number");
    expect(typeof section.mean_confidence).toBe("number");
    expect(section.mean_confidence).toBe(0.9);
  });

  it("raises for a document recon holds no notice for", async () => {
    // Absent, not empty: the caller answers 404, which is a different thing from an extraction with no
    // fields in it.
    send.mockResolvedValue({});
    await expect(
      readNoticeExtraction({ objectKey: "never-seen.pdf" }),
    ).rejects.toBeInstanceOf(UnknownDocumentError);
  });

  it("reports the stored reason when the detail was dropped to fit the row", async () => {
    // The branch that survives: the hook HAD the detail and dropped it to stay under DynamoDB's item
    // limit. A genuinely reachable state, unlike the migration case this file used to assert.
    const reason =
      "the extraction was 812345 bytes, over the 380000-byte row budget";
    send.mockResolvedValue({
      Item: row("big.pdf", {
        record_kind: "notice",
        idp_sections_omitted: reason,
      }),
    });
    const got = await readNoticeExtraction({ objectKey: "big.pdf" });
    // The stored sentence names the sizes, so it is shown rather than paraphrased.
    expect(got.unavailable).toBe(reason);
    expect(got.sections).toEqual([]);
  });

  it("reports the row's own reason for a document that never became a notice", async () => {
    // The row an operator actually meets: IDP finished the document, recon could not map a notice out
    // of it because nothing in it gave a notice date, and the row records that. The reason belongs to
    // the row -- the reader must not substitute an explanation of its own.
    send.mockResolvedValue({
      Item: row("fax-cover.pdf", {
        record_kind: "document",
        notice_failure_reason: "extracted no notice_date",
      }),
    });
    const got = await readNoticeExtraction({ objectKey: "fax-cover.pdf" });
    expect(got.unavailable).toContain("extracted no notice_date");
    // Says WHOSE failure it was, because the table renders this as a single line beside a filename.
    expect(got.unavailable).toContain("recon mapped no notice");
    // And never the sentence that used to be returned here, which claimed the document was extracted
    // before recon stored per-field detail and that re-uploading would fix it. Both false: this
    // document was extracted today, and re-uploading it produces the same unmappable document.
    expect(got.unavailable).not.toMatch(/re-uploading/i);
    expect(got.sections).toEqual([]);
  });

  it("admits it when a tracking row carries no reason at all", async () => {
    // `_failure_reason` in `backend/idp_hook/handler.py` guarantees a non-blank string, so this is only
    // reachable if something else wrote the row. It still must not fall back to inventing a cause.
    send.mockResolvedValue({
      Item: row("bare.pdf", { record_kind: "document" }),
    });
    const got = await readNoticeExtraction({ objectKey: "bare.pdf" });
    expect(got.unavailable).toBe(
      "recon mapped no notice from this document and recorded no reason for it",
    );
    expect(got.sections).toEqual([]);
  });

  it("states plainly that a notice carries no per-field detail, with no invented cause", async () => {
    // The residual case: a `notice` row with no `idp_sections` attribute. Nothing on the row says why,
    // so nothing here says why either -- the sentence that used to fill the gap ("extracted before
    // recon stored per-field detail ... re-uploading produces a notice that has it") was written for
    // rows predating 2026-09-08, and the notices table is deliberately never seeded, so no deployment
    // can hold one.
    send.mockResolvedValue({
      Item: row("plain.pdf", { record_kind: "notice" }),
    });
    const got = await readNoticeExtraction({ objectKey: "plain.pdf" });
    expect(got.unavailable).toBe(
      "recon has no per-field detail stored for this document",
    );
    expect(got.unavailable).not.toMatch(/re-uploading/i);
    expect(got.unavailable).not.toMatch(/before recon stored/i);
    expect(got.sections).toEqual([]);
  });

  it("treats a row with no record_kind as a notice rather than as a document", async () => {
    // ⚠️ ABSENT means `"notice"` -- 16 live rows predate the attribute. The row here also carries a
    // `notice_failure_reason`, which no notice row should have, precisely to pin down that the branch
    // keys on `record_kind` and not on a reason being present: a truthiness test on either would
    // report this row as a document that never became a notice.
    send.mockResolvedValue({
      Item: row("legacy.pdf", {
        notice_failure_reason: "extracted no notice_date",
      }),
    });
    const got = await readNoticeExtraction({ objectKey: "legacy.pdf" });
    expect(got.unavailable).toBe(
      "recon has no per-field detail stored for this document",
    );
    expect(got.unavailable).not.toContain("mapped no notice");
  });

  it("treats an empty section list as a real answer rather than a gap", async () => {
    // 17 of 35 live section results carry no explainability at all. "The extractor read nothing" is
    // information, and attaching a reason to it would send an operator looking for a fault.
    send.mockResolvedValue({ Item: row("blank.pdf", { idp_sections: [] }) });
    const got = await readNoticeExtraction({ objectKey: "blank.pdf" });
    expect(got.sections).toEqual([]);
    expect(got.unavailable).toBeNull();
  });

  it("refuses to read anything when the table name is not configured", async () => {
    // No fallback on purpose: a default would read the wrong table and report an empty extraction as
    // the truth.
    delete process.env.NOTICES_TABLE;
    try {
      await expect(
        readNoticeExtraction({ objectKey: "a.pdf" }),
      ).rejects.toThrow(/NOTICES_TABLE/);
      expect(send).not.toHaveBeenCalled();
    } finally {
      process.env.NOTICES_TABLE = TABLE;
    }
  });
});

describe("readNoticeExtractions", () => {
  it("reads a whole page in one request, keyed back to the object keys asked about", async () => {
    send.mockResolvedValue({
      Responses: {
        [TABLE]: [
          row("a.pdf", { idp_sections: [SECTION] }),
          row("b.pdf", { idp_sections: [] }),
        ],
      },
    });
    const got = await readNoticeExtractions({
      objectKeys: ["a.pdf", "b.pdf"],
    });
    expect(send).toHaveBeenCalledTimes(1);
    // The notice id is derived, so the answer has to be mapped back -- a caller that asked about
    // `a.pdf` cannot look up `idp-a.pdf`.
    expect(Object.keys(got.extractions).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(got.extractions["a.pdf"]).toHaveLength(1);
    expect(got.extractions["b.pdf"]).toEqual([]);
    expect(got.failed).toEqual({});
  });

  it("chunks at a hundred keys, which is BatchGetItem's ceiling", async () => {
    send.mockResolvedValue({ Responses: { [TABLE]: [] } });
    const objectKeys = Array.from({ length: 150 }, (_, i) => `${i}.pdf`);
    await readNoticeExtractions({ objectKeys });
    expect(send).toHaveBeenCalledTimes(2);
    const first = inputOf(0) as { RequestItems: Record<string, { Keys: [] }> };
    const second = inputOf(1) as { RequestItems: Record<string, { Keys: [] }> };
    expect(first.RequestItems[TABLE].Keys).toHaveLength(100);
    expect(second.RequestItems[TABLE].Keys).toHaveLength(50);
  });

  it("reports a key with no row against that key and answers for the rest", async () => {
    // One document recon never wrote a notice for must not cost the operator the rest of the page.
    send.mockResolvedValue({
      Responses: { [TABLE]: [row("ok.pdf", { idp_sections: [SECTION] })] },
    });
    const got = await readNoticeExtractions({
      objectKeys: ["ok.pdf", "gone.pdf"],
    });
    expect(Object.keys(got.extractions)).toEqual(["ok.pdf"]);
    expect(got.failed["gone.pdf"]).toContain("no notice");
  });

  it("routes a row whose detail was dropped into the per-key reasons", async () => {
    // Not into `extractions` as an empty list: the table would then show blank columns for a document
    // that WAS extracted, with nothing to say why.
    send.mockResolvedValue({
      Responses: {
        [TABLE]: [row("big.pdf", { idp_sections_omitted: "over the budget" })],
      },
    });
    const got = await readNoticeExtractions({ objectKeys: ["big.pdf"] });
    expect(got.extractions).toEqual({});
    expect(got.failed["big.pdf"]).toBe("over the budget");
  });

  it("routes a tracking row's own reason into the per-key reasons", async () => {
    // The path the Documents tab reads. Both readers share `unavailableReason`, so the line under the
    // table and the line in the detail panel cannot say different things about the same row -- and this
    // is the one the operator saw the wrong sentence on.
    send.mockResolvedValue({
      Responses: {
        [TABLE]: [
          row("ok.pdf", { idp_sections: [SECTION] }),
          row("fax-cover.pdf", {
            record_kind: "document",
            notice_failure_reason: "extracted no notice_date",
          }),
        ],
      },
    });
    const got = await readNoticeExtractions({
      objectKeys: ["ok.pdf", "fax-cover.pdf"],
    });
    expect(Object.keys(got.extractions)).toEqual(["ok.pdf"]);
    expect(got.failed["fax-cover.pdf"]).toBe(
      "recon mapped no notice from this document: extracted no notice_date",
    );
    expect(got.failed["fax-cover.pdf"]).not.toMatch(/re-uploading/i);
  });

  it("retries the keys DynamoDB left unprocessed", async () => {
    // BatchGetItem returns UnprocessedKeys on throttling, or when a response would exceed 16 MB.
    send
      .mockResolvedValueOnce({
        Responses: { [TABLE]: [row("a.pdf", { idp_sections: [SECTION] })] },
        UnprocessedKeys: {
          [TABLE]: { Keys: [marshall({ notice_id: noticeIdFor("b.pdf") })] },
        },
      })
      .mockResolvedValueOnce({
        Responses: { [TABLE]: [row("b.pdf", { idp_sections: [SECTION] })] },
      });
    const got = await readNoticeExtractions({
      objectKeys: ["a.pdf", "b.pdf"],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(Object.keys(got.extractions).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(got.failed).toEqual({});
  });

  it("reports a key still unprocessed after the retry rather than dropping it", async () => {
    // Dropping it would make a throttled read indistinguishable from a document that was never
    // extracted -- the worst of the failure modes here, because nothing anywhere would say so.
    const unprocessed = {
      [TABLE]: { Keys: [marshall({ notice_id: noticeIdFor("b.pdf") })] },
    };
    send.mockResolvedValue({
      Responses: { [TABLE]: [] },
      UnprocessedKeys: unprocessed,
    });
    const got = await readNoticeExtractions({ objectKeys: ["b.pdf"] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(got.failed["b.pdf"]).toContain("did not answer");
  });

  it("makes no request at all for an empty key list", async () => {
    const got = await readNoticeExtractions({ objectKeys: [] });
    expect(send).not.toHaveBeenCalled();
    expect(got).toEqual({ extractions: {}, failed: {} });
  });
});
