// @vitest-environment node
/**
 * The override lesson text and the override read helpers.
 *
 * The lesson is the only thing the `edge_cases` extractor sees of an override, so what it must carry
 * is pinned here: the parser's value and the correction, the reason verbatim, the rejection codes on
 * a break fix, a bounded excerpt of the email, and the deal attributes a rule could hang on — never
 * the overridden field itself as "context", which would read as a trigger for its own value.
 */
import { describe, expect, it } from "vitest";

import { emptyFields } from "@/lib/pipeline/omsSchema";
import { latestOverrides, overridesOf } from "@/lib/pipeline/overrides";
import { overrideLessonText } from "@/lib/pipeline/server/memoryClient";
import type { FieldOverride } from "@/lib/pipeline/types";

const override: FieldOverride = {
  override_id: "ov_1",
  field: "secured_level",
  parsed_value: "Senior Secured",
  previous_value: "Senior Secured",
  value: "First Lien",
  reason: "Project-finance TLBs book as First Lien in the OMS even when the notice says senior secured.",
  actor: "reviewer",
  at: "2026-08-13T10:05:00Z",
  stage: "review",
  memory: { status: "pending" },
};

const fields = {
  ...emptyFields(),
  pipeline_type: "Loan",
  uop: "Project Finance",
  secured_level: "First Lien",
  currency: "USD",
};

describe("overrideLessonText", () => {
  it("states the correction, the reason, and the deal attributes a rule could hang on", () => {
    const text = overrideLessonText(override, {
      email: { source_kind: "bank-notice", subject: "Harbor Wind - $600MM TLB - Launch" },
      fields,
      evidence: { value: "Senior Secured", confidence: "medium", excerpt: "Ranking: senior secured", rule: "ranking maps to Secured Level" },
    });
    expect(text.split("\n")).toEqual([
      "Deal-desk override of a parsed OMS field.",
      "Field: Secured Level",
      'Parser value: "Senior Secured"',
      'Corrected value: "First Lien"',
      `Reviewer's reason: ${override.reason}`,
      "Email text the parser read: Ranking: senior secured",
      "Rule the parser applied: ranking maps to Secured Level",
      "Deal attributes: Pipeline Type = Loan; UOP = Project Finance; Currency = USD",
      'Source: bank-notice email, subject "Harbor Wind - $600MM TLB - Launch"',
    ]);
  });

  it("names the rejection a break fix satisfies and the value an earlier override left", () => {
    const text = overrideLessonText(
      { ...override, stage: "break", upload_error_codes: ["PROJECT_FINANCE_LIEN"], previous_value: "Second Lien" },
      { email: null, fields },
    );
    expect(text).toContain('Value before this override: "Second Lien"');
    expect(text).toContain("Made to fix an OMS upload rejection (codes: PROJECT_FINANCE_LIEN).");
    expect(text).not.toContain("Source:");
  });

  it("bounds a long excerpt and quotes a blank value as blank", () => {
    const text = overrideLessonText(
      { ...override, parsed_value: "", previous_value: "" },
      { email: null, fields, evidence: { value: "", confidence: "low", excerpt: "x".repeat(1000) } },
    );
    expect(text).toContain("Parser value: (blank)");
    const excerpt = text.split("\n").find((l) => l.startsWith("Email text"))!;
    expect(excerpt.length).toBeLessThan(450);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("override helpers", () => {
  it("read an absent list as empty and keep the latest override per field", () => {
    expect(overridesOf({})).toEqual([]);
    const later = { ...override, override_id: "ov_2", value: "Second Lien" };
    const other = { ...override, override_id: "ov_3", field: "uop" };
    expect(latestOverrides({ overrides: [override, other, later] })).toEqual({
      secured_level: later,
      uop: other,
    });
  });
});
