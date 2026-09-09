/**
 * The join between an extracted value and its confidence.
 *
 * `flattenExtractedFields` walks `inference_result` here in the browser; the confidence records it
 * joins against are built by `field_confidences` in `backend/idp_hook/explainability.py` and embedded
 * on the notice row at ingest. The field path is the ONLY thing that pairs the two, and they are now on
 * opposite sides of a language boundary, so nothing at build time can catch a drift. Nothing throws at
 * runtime either: every value renders with an em dash where its confidence should be, which reads as
 * "the extractor scored nothing" rather than as a bug.
 *
 * `RECORDS` below is therefore the contract, written in the notation the Python emits — dotted for
 * nested objects, `[i]` for array rows. The Python side pins the same notation in
 * `tests/idp_hook/test_explainability.py::test_flattens_nested_arrays_and_pairs_each_field_with_its_value`,
 * and the agreement tests here matter more than any of the unit assertions around them.
 */
import { describe, expect, it } from "vitest";

import {
  confidenceByField,
  confidenceText,
  fieldText,
  flattenExtractedFields,
  isBelowThreshold,
} from "@/lib/idpFields";
import type { ExtractedFieldConfidence } from "@/lib/reconApi";

const INFERENCE = {
  BorrowerName: "Cascade Holdings LLC",
  Date: "2026-08-01",
  AccrualLineItems: [{ Amount: "1,250,000.00" }, { Amount: "42.00" }],
  Lender: { Name: "First Bank", Branch: "" },
};

// What the hook stores for the document above. Per-field thresholds (0.8 and 0.9 both occur live),
// `Fax` scored but never extracted, and `Lender.Branch` scored with a blank value -- which the Python
// counts as NOT extracted, the same rule this side's `isBelowThreshold` depends on.
const RECORDS: ExtractedFieldConfidence[] = [
  { field: "BorrowerName", confidence: 1.0, threshold: 0.8, extracted: true },
  { field: "Date", confidence: 0.9, threshold: 0.8, extracted: true },
  { field: "Fax", confidence: 0.0, threshold: 0.8, extracted: false },
  {
    field: "AccrualLineItems[0].Amount",
    confidence: 0.95,
    threshold: 0.9,
    extracted: true,
  },
  {
    field: "AccrualLineItems[1].Amount",
    confidence: 0.5,
    threshold: 0.9,
    extracted: true,
  },
  { field: "Lender.Name", confidence: 0.99, threshold: 0.8, extracted: true },
  { field: "Lender.Branch", confidence: 0.2, threshold: 0.8, extracted: false },
];

describe("flattenExtractedFields", () => {
  it("emits one entry per leaf, in the extractor's own key order", () => {
    // Not sorted: IDP emits fields in the order its schema declares them, which is the order a reviewer
    // reads them off the page. Alphabetising would put a total above the line items that sum to it.
    expect(flattenExtractedFields(INFERENCE).map((f) => f.field)).toEqual([
      "BorrowerName",
      "Date",
      "AccrualLineItems[0].Amount",
      "AccrualLineItems[1].Amount",
      "Lender.Name",
      "Lender.Branch",
    ]);
  });

  it("keeps a blank leaf as a field rather than dropping it", () => {
    // `Lender.Branch` is "" — the notice has the field and left it empty, which is not the same as the
    // schema never asking for it.
    const branch = flattenExtractedFields(INFERENCE).find(
      (f) => f.field === "Lender.Branch",
    );
    expect(branch).toBeDefined();
    expect(branch!.value).toBe("");
  });

  it("treats an empty object or array as a leaf instead of descending into nothing", () => {
    // Descending yields no entries at all, so the field would vanish from the panel.
    expect(
      flattenExtractedFields({ Empty: {}, None: [], Zero: 0, No: false }).map(
        (f) => f.field,
      ),
    ).toEqual(["Empty", "None", "Zero", "No"]);
  });

  it("is not confused by a document field named `confidence`", () => {
    expect(
      flattenExtractedFields({ Nested: { confidence: "v" } }).map(
        (f) => f.field,
      ),
    ).toEqual(["Nested.confidence"]);
  });
});

describe("path agreement with the stored confidence records", () => {
  it("gives every extracted value a confidence to pair with", () => {
    const scores = confidenceByField(RECORDS);
    const unpaired = flattenExtractedFields(INFERENCE)
      .map((f) => f.field)
      .filter((field) => !scores.has(field));
    expect(unpaired).toEqual([]);
  });

  it("leaves only the fields the document did not carry unmatched in the other direction", () => {
    const present = new Set(
      flattenExtractedFields(INFERENCE).map((f) => f.field),
    );
    const scoredButAbsent = RECORDS.filter((r) => !present.has(r.field)).map(
      (r) => r.field,
    );
    // Exactly Fax: scored 0.0 with no value. Anything else here would be a notation drift.
    expect(scoredButAbsent).toEqual(["Fax"]);
  });
});

describe("isBelowThreshold", () => {
  const scores = confidenceByField(RECORDS);

  it("flags an extracted field under its own threshold", () => {
    expect(isBelowThreshold(scores.get("AccrualLineItems[1].Amount"))).toBe(
      true,
    );
    expect(isBelowThreshold(scores.get("AccrualLineItems[0].Amount"))).toBe(
      false,
    );
  });

  it("uses the field's own threshold rather than a shared one", () => {
    // 0.95 clears 0.9 here; against the 0.8-threshold fields it would be well clear too. The pair that
    // proves the point is 0.9 vs 0.95 against different thresholds -- Date at 0.9 is fine, and a global
    // 0.9 constant would have flagged it.
    expect(isBelowThreshold(scores.get("Date"))).toBe(false);
    expect(scores.get("Date")!.threshold).toBe(0.8);
  });

  it("does not flag a field the document never carried", () => {
    // Fax is 0.0 against 0.8 and is still not an alert: an absent optional field is not a data-quality
    // problem, and counting it would make the flag a function of how broad the schema is.
    expect(isBelowThreshold(scores.get("Fax"))).toBe(false);
  });

  it("does not flag a field with no threshold or no record", () => {
    expect(isBelowThreshold(undefined)).toBe(false);
    expect(
      isBelowThreshold({
        field: "X",
        confidence: 0.1,
        threshold: null,
        extracted: true,
      }),
    ).toBe(false);
  });
});

describe("fieldText", () => {
  it("renders absences as an em dash and booleans as words", () => {
    expect(fieldText(null)).toBe("—");
    expect(fieldText(undefined)).toBe("—");
    expect(fieldText("")).toBe("—");
    expect(fieldText(true)).toBe("yes");
    expect(fieldText(false)).toBe("no");
  });

  it("keeps a numeric zero rather than showing it as an absence", () => {
    // A 0 amount is extracted data. Rendering it as an em dash would report a real figure as missing.
    expect(fieldText(0)).toBe("0");
  });

  it("renders an empty structure as JSON rather than as [object Object]", () => {
    expect(fieldText({})).toBe("{}");
    expect(fieldText([])).toBe("[]");
  });
});

describe("confidenceText", () => {
  it("shows two decimals, and an em dash when there is no score", () => {
    expect(confidenceText(0.5)).toBe("0.50");
    expect(confidenceText(1)).toBe("1.00");
    // Not "0.00": a field the extractor did not score is different from one it scored zero.
    expect(confidenceText(null)).toBe("—");
    expect(confidenceText(undefined)).toBe("—");
    expect(confidenceText(0)).toBe("0.00");
  });
});
