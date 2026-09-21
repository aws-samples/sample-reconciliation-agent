/**
 * The parsed-fields panel beside an email.
 *
 * The confidence chips are the reviewer's scan path through seventy fields, so each band must render
 * as its own colour class and the excerpt behind a value must be one click away. The in-flight and
 * failed states are pinned too, because a PARSING email is the state the demo watches longest.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ParsedFieldsPanel } from "@/components/pipeline/ParsedFieldsPanel";
import { emptyFields } from "@/lib/pipeline/omsSchema";
import type { EmailRecord } from "@/lib/pipeline/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function email(over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    email_id: "em_1",
    received_at: "2026-08-05T13:58:00Z",
    source_kind: "bank-notice",
    from: "Syndicated Finance <syndicate@silverlinepartners.example>",
    to: "New Issues Desk <new-issues@example-firm.test>",
    subject: "Copperfield Insurance Partners - $1,295MM Term Loan B Refinancing - Launch",
    sent: "2026-08-05T13:41:00Z",
    body: "…",
    sample_id: "06-bank-notice-copperfield-insurance-tlb",
    status: "PARSED",
    deal_id: "dl_1",
    error: null,
    updated_at: "2026-08-05T13:59:00Z",
    parse: {
      fields: {
        ...emptyFields(),
        pipeline_type: "Loan",
        opportunity_name: "Copperfield TLB refinancing",
        issue_size_mm: "1295.000",
        left_agent: "Silverline Partners",
        covenant_status_num: "",
      },
      evidence: {
        pipeline_type: { value: "Loan", confidence: "high", excerpt: "Facility: $1,295 million Term Loan B" },
        issue_size_mm: {
          value: "1295.000",
          confidence: "high",
          excerpt: "Facility:            $1,295 million Term Loan B",
          rule: "amounts in millions with three decimals",
        },
        left_agent: {
          value: "Silverline Partners",
          confidence: "medium",
          excerpt: "Silverline Partners, on behalf of the arranger group",
        },
        covenant_status_num: {
          value: "",
          confidence: "low",
          excerpt: "Financial Covenant:  Cov-Lite",
          rule: "no mapping from covenant wording to a status number",
        },
      },
      assumptions: ["Date Arrived taken from the forwarding email, not the original notice."],
      memory_hits: [{ record_id: "mem-1", text: "Insurance-brokerage sponsors are listed with ' / ' separators." }],
      skills_used: ["deal-parsing"],
      enrichment: { issuer_match: "Copperfield Insurance Partners", fields_from_security_master: ["region", "industry", "sponsors"] },
      model_id: "us.anthropic.claude-sonnet-5",
      duration_ms: 12400,
    },
    ...over,
  };
}

describe("ParsedFieldsPanel", () => {
  it("renders one confidence chip per evidenced field, in its band", () => {
    render(<ParsedFieldsPanel email={email()} />);
    const chips = document.querySelectorAll("[data-confidence]");
    const bands = [...chips].map((c) => c.getAttribute("data-confidence"));
    expect(bands.sort()).toEqual(["high", "high", "low", "medium"]);
    // Bands are colour-coded through the chip's inline colour, one CSS variable per band.
    const byBand = (b: string) => document.querySelector(`[data-confidence="${b}"]`) as HTMLElement;
    expect(byBand("high").style.color).toContain("--rc-green");
    expect(byBand("medium").style.color).toContain("--rc-amber");
    expect(byBand("low").style.color).toContain("--rc-red");
  });

  it("shows the run metadata, skills, memory hits and enrichment", () => {
    render(<ParsedFieldsPanel email={email()} />);
    expect(screen.getByText("us.anthropic.claude-sonnet-5")).toBeTruthy();
    expect(screen.getByText("12.4 s")).toBeTruthy();
    expect(screen.getByText("deal-parsing")).toBeTruthy();
    expect(within(screen.getByTestId("memory-hits")).getByText(/Insurance-brokerage sponsors/)).toBeTruthy();
    expect(screen.getByText(/security master → Copperfield Insurance Partners/)).toBeTruthy();
    expect(screen.getByText("sponsors")).toBeTruthy();
    expect(screen.getByText(/Date Arrived taken from the forwarding email/)).toBeTruthy();
  });

  it("opens the excerpt and rule behind a field", () => {
    render(<ParsedFieldsPanel email={email()} />);
    expect(screen.queryByText(/amounts in millions with three decimals/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Issue Size \(MM\)/ }));
    expect(screen.getByText(/Facility:\s+\$1,295 million Term Loan B/)).toBeTruthy();
    expect(screen.getByText(/amounts in millions with three decimals/)).toBeTruthy();
  });

  it("hides blank fields by default but keeps a blank one that carries evidence", () => {
    render(<ParsedFieldsPanel email={email()} />);
    // Covenant Status # is blank AND evidenced (the gap the demo teaches), so it must stay visible.
    expect(screen.getByRole("button", { name: /Covenant Status #/ })).toBeTruthy();
    // Trader is blank with no evidence: hidden until asked for.
    expect(screen.queryByText("Trader")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show blank fields" }));
    expect(screen.getByText("Trader")).toBeTruthy();
  });

  it("offers the deal link and re-parse action", () => {
    const onReparse = vi.fn();
    render(<ParsedFieldsPanel email={email()} onReparse={onReparse} />);
    expect(screen.getByRole("link", { name: /Open deal/ })).toHaveAttribute("href", "/pipeline/deals/dl_1");
    fireEvent.click(screen.getByRole("button", { name: "Re-parse" }));
    expect(onReparse).toHaveBeenCalled();
  });

  it("shows a live placeholder while parsing and disables re-parse", () => {
    render(<ParsedFieldsPanel email={email({ status: "PARSING", parse: null, deal_id: null })} onReparse={vi.fn()} />);
    expect(screen.getByText(/the parsing agent is reading the email/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-parse" })).toBeDisabled();
    expect(document.querySelector('[data-status="PARSING"]')).toHaveClass("live");
  });

  it("names the failure on a PARSE_FAILED email", () => {
    render(<ParsedFieldsPanel email={email({ status: "PARSE_FAILED", parse: null, error: "model timed out" })} />);
    expect(screen.getByText(/Parse failed — model timed out/)).toBeTruthy();
  });
});
