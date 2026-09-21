/**
 * The deal review grid.
 *
 * What it must get right is the edit loop: a control shaped by the column's type, the same validation
 * message the PATCH would produce shown under the offending value, and a visible mark on anything that
 * differs from what the parser read — because "the reviewer changed this" is the one fact the OMS
 * upload cannot tell you afterwards.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DealFieldGrid } from "@/components/pipeline/DealFieldGrid";
import { emptyFields, validateFields } from "@/lib/pipeline/omsSchema";
import type { FieldEvidence, FieldValues } from "@/lib/pipeline/types";

const ORIGINAL: FieldValues = {
  ...emptyFields(),
  pipeline_type: "Loan",
  opportunity_name: "Cascade first-lien TLB",
  issue_size_mm: "700.000",
  is_secured: "Yes",
  secured_level: "Senior Secured",
};

const EVIDENCE: Record<string, FieldEvidence> = {
  issue_size_mm: {
    value: "700.000",
    confidence: "high",
    excerpt: "Size:                $700,000,000",
    rule: "dollars to millions with three decimals",
  },
  secured_level: {
    value: "Senior Secured",
    confidence: "low",
    excerpt: "Facility:            First Lien Term Loan B",
  },
};

/** The grid's row for one field key. */
function row(key: string): HTMLElement {
  const el = document.querySelector(`[data-field="${key}"]`);
  if (!el) throw new Error(`no row for ${key}`);
  return el as HTMLElement;
}

describe("DealFieldGrid", () => {
  it("shows values read-only with confidence chips when not editing", () => {
    render(
      <DealFieldGrid
        fields={ORIGINAL}
        original={ORIGINAL}
        evidence={EVIDENCE}
        editing={false}
        problems={{}}
        onChange={vi.fn()}
      />,
    );
    expect(within(row("issue_size_mm")).getByText("700.000")).toBeTruthy();
    expect(within(row("issue_size_mm")).getByText("high")).toHaveAttribute("data-confidence", "high");
    expect(within(row("secured_level")).getByText("low")).toHaveAttribute("data-confidence", "low");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders a select for enums and booleans and a text input with a format placeholder otherwise", () => {
    render(
      <DealFieldGrid
        fields={ORIGINAL}
        original={ORIGINAL}
        evidence={{}}
        editing
        problems={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Pipeline Type" })).toBeTruthy();
    const secured = screen.getByRole("combobox", { name: "Is Secured?" }) as HTMLSelectElement;
    expect([...secured.options].map((o) => o.value)).toEqual(["", "Yes", "No"]);
    expect(screen.getByRole("textbox", { name: "Issue Size (MM)" })).toHaveAttribute(
      "placeholder",
      "millions with 3 decimals, e.g. 500.000",
    );
    // Maturity Date sits in a section the fixture fills, so it is rendered; the dates section is folded.
    expect(screen.getByRole("textbox", { name: "Maturity Date" })).toHaveAttribute("placeholder", "M/D/YYYY");
  });

  it("reports edits through onChange and shows the validation problem inline", () => {
    const onChange = vi.fn();
    const draft = { ...ORIGINAL, issue_size_mm: "700" };
    render(
      <DealFieldGrid
        fields={draft}
        original={ORIGINAL}
        evidence={{}}
        editing
        problems={validateFields(draft)}
        onChange={onChange}
      />,
    );
    const alert = within(row("issue_size_mm")).getByRole("alert");
    expect(alert).toHaveTextContent("expected millions with 3 decimals, e.g. 500.000");

    fireEvent.change(screen.getByRole("textbox", { name: "Issue Size (MM)" }), {
      target: { value: "700.000" },
    });
    expect(onChange).toHaveBeenCalledWith("issue_size_mm", "700.000");
  });

  it("marks a value that differs from what the parser read", () => {
    render(
      <DealFieldGrid
        fields={{ ...ORIGINAL, secured_level: "First Lien" }}
        original={ORIGINAL}
        evidence={EVIDENCE}
        editing={false}
        problems={{}}
        onChange={vi.fn()}
      />,
    );
    const changed = within(row("secured_level")).getByText("edited");
    expect(changed).toHaveAttribute("data-changed", "true");
    expect(changed).toHaveAttribute("title", "as parsed: Senior Secured");
    expect(within(row("issue_size_mm")).queryByText("edited")).toBeNull();
  });

  it("opens the evidence excerpt and rule on demand", () => {
    render(
      <DealFieldGrid
        fields={ORIGINAL}
        original={ORIGINAL}
        evidence={EVIDENCE}
        editing={false}
        problems={{}}
        onChange={vi.fn()}
      />,
    );
    const r = row("issue_size_mm");
    expect(within(r).queryByText(/dollars to millions/)).toBeNull();
    fireEvent.click(within(r).getByRole("button", { name: /evidence/ }));
    expect(within(r).getByText(/Size:\s+\$700,000,000/)).toBeTruthy();
    expect(within(r).getByText(/dollars to millions with three decimals/)).toBeTruthy();
  });
});
