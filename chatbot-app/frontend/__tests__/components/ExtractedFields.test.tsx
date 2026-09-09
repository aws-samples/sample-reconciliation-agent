/**
 * The Documents tab's extracted-fields panel.
 *
 * Before this panel the tab showed the pipeline's tracking record and the raw PDF, so an operator could
 * see that three attributes were doubtful and never what any of the other twenty said. The point of
 * every assertion below is that a reader can tell four states apart on sight:
 *
 *   - a field with a value and a confidence,
 *   - a field with a value scored BELOW ITS OWN threshold (flagged, and per-field: 0.8 and 0.9 both
 *     occur live, so a shared constant would flag the wrong rows),
 *   - a field the schema asked for that this document did not carry,
 *   - a section whose stored result could not be read at all.
 *
 * The last one is the one worth guarding hardest: rendering it as "no fields" would turn an expired
 * result JSON into a claim that the extractor found nothing in the document.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExtractedFields } from "@/components/recon/ExtractedFields";
import type { ExtractedSection } from "@/lib/reconApi";

/** A live-shaped section: two clean fields, one flagged table row, one field the notice omitted. */
function section(overrides: Partial<ExtractedSection> = {}): ExtractedSection {
  return {
    section_id: "1",
    classification: "paydown_notice",
    page_ids: [1, 2],
    fields: {
      BorrowerName: "Cascade Holdings LLC",
      AccrualLineItems: [{ Amount: "1,250,000.00" }, { Amount: "42.00" }],
    },
    confidences: [
      {
        field: "BorrowerName",
        confidence: 1.0,
        threshold: 0.8,
        extracted: true,
      },
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
      { field: "Fax", confidence: 0.0, threshold: 0.8, extracted: false },
    ],
    mean_confidence: 0.8166666666666667,
    alert_count: 1,
    ...overrides,
  };
}

describe("ExtractedFields", () => {
  it("shows every extracted field with its own confidence", () => {
    render(<ExtractedFields sections={[section()]} />);
    // The values...
    expect(screen.getByText("Cascade Holdings LLC")).toBeTruthy();
    expect(screen.getByText("1,250,000.00")).toBeTruthy();
    expect(screen.getByText("42.00")).toBeTruthy();
    // ...each with a score beside it, including the two table rows scored differently.
    expect(screen.getByText("1.00")).toBeTruthy();
    expect(screen.getByText("0.95")).toBeTruthy();
    expect(screen.getByText("0.50")).toBeTruthy();
  });

  it("names the nested table rows individually rather than as one field", () => {
    render(<ExtractedFields sections={[section()]} />);
    // A confidence belongs to a leaf, so the row index has to survive into the label — otherwise the
    // 0.50 has nothing to point at and the operator cannot tell which row to re-check.
    expect(screen.getByTitle("AccrualLineItems[0].Amount")).toBeTruthy();
    expect(screen.getByTitle("AccrualLineItems[1].Amount")).toBeTruthy();
  });

  it("flags only the field below its own threshold", () => {
    render(<ExtractedFields sections={[section()]} />);
    const amber = "var(--rc-amber)";
    // 0.50 against 0.9 is flagged; 0.95 against the same 0.9 is not, and neither is 1.00 against 0.8.
    expect(screen.getByText("0.50").getAttribute("style")).toContain(amber);
    expect(screen.getByText("0.95").getAttribute("style")).not.toContain(amber);
    expect(screen.getByText("1.00").getAttribute("style")).not.toContain(amber);
  });

  it("does not flag a field scored below threshold that the document never carried", () => {
    // Fax is 0.0 against 0.8. It is reported as absent, NOT as a low-confidence reading: an optional
    // field the notice omitted is not a data-quality alert, and the hook's own count agrees.
    render(<ExtractedFields sections={[section()]} />);
    expect(screen.getByText(/Asked for but not present/)).toBeTruthy();
    expect(screen.getByText(/Asked for but not present/).textContent).toContain(
      "Fax",
    );
  });

  it("shows the section's aggregate and its alert count", () => {
    render(<ExtractedFields sections={[section()]} />);
    // The same numbers the hook stores on a notice, so the panel cannot disagree with the platform.
    expect(screen.getByText(/mean 0\.817/)).toBeTruthy();
    expect(screen.getByText("1 below threshold")).toBeTruthy();
    expect(screen.getByText("paydown_notice")).toBeTruthy();
    expect(screen.getByText("pages 1, 2")).toBeTruthy();
  });

  it("says a section could not be read instead of showing it as empty", () => {
    render(
      <ExtractedFields
        sections={[
          section({
            fields: {},
            confidences: [],
            mean_confidence: null,
            alert_count: 0,
            error: "the pipeline returned no file contents",
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Could not read what was extracted/)).toBeTruthy();
    expect(screen.queryByText(/returned no fields/)).toBeNull();
  });

  it("distinguishes a readable section that produced nothing", () => {
    render(
      <ExtractedFields
        sections={[
          section({
            fields: {},
            confidences: [],
            mean_confidence: null,
            alert_count: 0,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/returned no fields/)).toBeTruthy();
    expect(screen.getByText(/mean —/)).toBeTruthy();
  });

  it("renders one group per section", () => {
    render(
      <ExtractedFields
        sections={[
          section(),
          section({ section_id: "2", classification: "wire_confirmation" }),
        ]}
      />,
    );
    expect(screen.getByText("paydown_notice")).toBeTruthy();
    expect(screen.getByText("wire_confirmation")).toBeTruthy();
  });

  it("says nothing was recorded when the document has no sections", () => {
    render(<ExtractedFields sections={[]} />);
    expect(screen.getByText(/recorded no sections/)).toBeTruthy();
  });
});
