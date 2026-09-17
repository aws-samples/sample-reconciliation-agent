/**
 * The OMS staging schema, as the browser sees it.
 *
 * Three concerns. The validators are what the review grid shows inline and what the PATCH enforces,
 * so each type's accept/reject boundary is pinned. `toCsv` is the file the mock OMS validates, so
 * its header and quoting are golden. And the schema is duplicated between Python and TypeScript by
 * design (design §5), so the last test is the one that makes the duplication safe.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import schemaJson from "@/lib/pipeline/omsFields.json";
import {
  changedKeys,
  emptyFields,
  fieldDef,
  fieldsBySection,
  formatHint,
  normalizeFields,
  OMS_FIELDS,
  OMS_SECTIONS,
  toCsv,
  validateFields,
  validateFieldValue,
} from "@/lib/pipeline/omsSchema";
import type { OmsFieldDef } from "@/lib/pipeline/types";

/** The definition for a key, asserting it exists so a renamed key fails loudly here. */
function def(key: string): OmsFieldDef {
  const d = fieldDef(key);
  if (!d) throw new Error(`no such field: ${key}`);
  return d;
}

describe("validateFieldValue", () => {
  it("accepts blanks on optional fields and refuses them on required ones", () => {
    expect(validateFieldValue(def("launch_date"), "")).toBeNull();
    expect(validateFieldValue(def("issue_size_mm"), "   ")).toBe("required");
  });

  it("date: M/D/YYYY without zero padding", () => {
    const d = def("commit_due");
    expect(validateFieldValue(d, "8/13/2026")).toBeNull();
    expect(validateFieldValue(d, "12/1/2026")).toBeNull();
    expect(validateFieldValue(d, "08/13/2026")).toMatch(/expected M\/D\/YYYY/);
    expect(validateFieldValue(d, "2026-08-13")).toMatch(/expected/);
    expect(validateFieldValue(d, "13/8/2026")).toMatch(/expected/);
  });

  it("time: h[:mm]AM|PM", () => {
    const d = def("commit_due_time");
    for (const ok of ["12PM", "1:15PM", "5:00PM", "9AM"]) expect(validateFieldValue(d, ok)).toBeNull();
    for (const bad of ["12:00", "noon", "13PM", "1:60PM", "1:15 PM"])
      expect(validateFieldValue(d, bad)).toMatch(/expected/);
  });

  it("percent: three decimals and a sign, negatives allowed", () => {
    const d = def("initial_spread_talk_low");
    expect(validateFieldValue(d, "2.000%")).toBeNull();
    expect(validateFieldValue(d, "-0.250%")).toBeNull();
    expect(validateFieldValue(d, "2%")).toMatch(/expected 0\.000%/);
    expect(validateFieldValue(d, "2.00%")).toMatch(/expected/);
    expect(validateFieldValue(d, "S+200")).toMatch(/expected/);
  });

  it("mm and price: three decimals, no separators", () => {
    expect(validateFieldValue(def("issue_size_mm"), "500.000")).toBeNull();
    expect(validateFieldValue(def("issue_size_mm"), "1295.000")).toBeNull();
    expect(validateFieldValue(def("issue_size_mm"), "1,295.000")).toMatch(/expected millions/);
    expect(validateFieldValue(def("issue_size_mm"), "500")).toMatch(/expected/);
    expect(validateFieldValue(def("initial_price_talk_low"), "99.500")).toBeNull();
    expect(validateFieldValue(def("initial_price_talk_low"), "99.5")).toMatch(/expected 3 decimals/);
  });

  it("integer: digits, with the schema's min/max where declared", () => {
    const cov = def("covenant_status_num");
    expect(validateFieldValue(cov, "3")).toBeNull();
    expect(validateFieldValue(cov, "0")).toBe("must be ≥ 1");
    expect(validateFieldValue(cov, "5")).toBe("must be ≤ 4");
    expect(validateFieldValue(cov, "three")).toBe("must be a whole number");
    expect(validateFieldValue(def("bps_taken_out"), "25")).toBeNull();
  });

  it("boolean: exactly Yes or No", () => {
    const d = def("is_secured");
    expect(validateFieldValue(d, "Yes")).toBeNull();
    expect(validateFieldValue(d, "No")).toBeNull();
    expect(validateFieldValue(d, "yes")).toMatch(/expected Yes or No/);
    expect(validateFieldValue(d, "TRUE")).toMatch(/expected/);
  });

  it("enum: an exact member of `values`", () => {
    const d = def("pipeline_type");
    expect(validateFieldValue(d, "Loan")).toBeNull();
    expect(validateFieldValue(d, "loan")).toBe("must be one of Loan, Bond");
    expect(validateFieldValue(def("uop"), "Project Finance")).toBeNull();
  });

  it("string: max_length and pattern where declared", () => {
    const name = def("opportunity_name");
    expect(validateFieldValue(name, "Northwind add-on TLB")).toBeNull();
    expect(validateFieldValue(name, "x".repeat(61))).toBe("longer than 60 characters");
    const tenor = def("maturity_terms");
    expect(validateFieldValue(tenor, "7 yr")).toBeNull();
    expect(validateFieldValue(tenor, "4.5 yr")).toBeNull();
    expect(validateFieldValue(tenor, "7 years")).toMatch(/must match/);
  });

  it("formatHint names every non-string format", () => {
    for (const type of ["date", "time", "percent", "mm", "price", "integer", "boolean"] as const)
      expect(formatHint(type)).not.toBe("text");
    expect(formatHint("string")).toBe("text");
  });
});

describe("validateFields / normalizeFields / emptyFields", () => {
  it("emptyFields carries every key with schema defaults applied", () => {
    const empty = emptyFields();
    expect(Object.keys(empty)).toHaveLength(OMS_FIELDS.length);
    expect(empty.pipeline_status).toBe("New");
    expect(empty.pct_commit).toBe("0.000%");
    expect(empty.opportunity_name).toBe("");
  });

  it("normalizeFields drops unknown keys and stringifies values", () => {
    const out = normalizeFields({ issue_size_mm: "500.000", not_a_field: "x", bps_taken_out: 25 as unknown as string });
    expect(out.issue_size_mm).toBe("500.000");
    expect(out.bps_taken_out).toBe("25");
    expect("not_a_field" in out).toBe(false);
  });

  it("validateFields reports only the required blanks and the bad formats", () => {
    const problems = validateFields({
      ...emptyFields(),
      pipeline_type: "Loan",
      opportunity_name: "Cascade first-lien TLB",
      date_arrived: "3/11/2026",
      maturity_terms: "7 yr",
      currency: "USD",
      issue_size_mm: "700",
      security_type: "Loan",
      fixed_floating: "Floating",
    });
    expect(problems).toEqual({ issue_size_mm: "expected millions with 3 decimals, e.g. 500.000" });
  });
});

describe("toCsv", () => {
  it("writes the labels in schema order, then one data row, with LF endings", () => {
    const csv = toCsv({ ...emptyFields(), pipeline_type: "Loan", opportunity_name: "Northwind add-on TLB" });
    const [header, row, tail] = csv.split("\n");
    expect(header.startsWith("Pipeline Status,Pipeline Type,Opportunity Name,Region,Sponsors,")).toBe(true);
    expect(header.split(",").length).toBe(OMS_FIELDS.length);
    expect(row.startsWith("New,Loan,Northwind add-on TLB,")).toBe(true);
    expect(tail).toBe("");
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("quotes commas, quotes and newlines per RFC 4180", () => {
    const csv = toCsv({ ...emptyFields(), notes: 'Fungible with existing, "cov-lite" TLB', desk_notes: "a\nb" });
    expect(csv).toContain('"Fungible with existing, ""cov-lite"" TLB"');
    expect(csv).toContain('"a\nb"');
  });

  it("golden: the Ratings header block", () => {
    const header = toCsv(emptyFields()).split("\n")[0];
    expect(header).toContain(
      "S&P Issue Rating,Moody's Issue Rating,Fitch Issue Rating,S&P Corp Rating,Moody's Corp Rating,Fitch Corp Rating,S&P Recovery Rating,Liquidity Score,Is Investment Grade?",
    );
  });
});

describe("changedKeys / fieldsBySection", () => {
  it("lists only the keys whose value differs, in schema order", () => {
    const original = emptyFields();
    const current = { ...original, secured_level: "First Lien", covenant_status_num: "3" };
    expect(changedKeys(original, current)).toEqual(["secured_level", "covenant_status_num"]);
  });

  it("groups every field under one of the six sections, in section order", () => {
    const grouped = fieldsBySection();
    expect(grouped.map((g) => g.section)).toEqual(OMS_SECTIONS);
    expect(grouped.reduce((n, g) => n + g.fields.length, 0)).toBe(OMS_FIELDS.length);
    expect(OMS_SECTIONS).toHaveLength(6);
  });
});

describe("schema parity", () => {
  it("the TypeScript mirror is byte-for-byte the backend schema", () => {
    // __tests__/lib → frontend → chatbot-app → repo root.
    const backendPath = join(__dirname, "..", "..", "..", "..", "backend", "deal_pipeline", "oms_fields.json");
    const backend = JSON.parse(readFileSync(backendPath, "utf8"));
    expect(schemaJson).toEqual(backend);
  });
});
