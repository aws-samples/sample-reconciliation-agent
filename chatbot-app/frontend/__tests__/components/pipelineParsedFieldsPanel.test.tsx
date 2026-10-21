/**
 * The parsed-fields panel beside an email.
 *
 * The confidence chips are the reviewer's scan path through seventy fields, so each band must render
 * as its own colour class and the excerpt behind a value must be one click away. The in-flight and
 * failed states are pinned too, because a PARSING email is the state the demo watches longest.
 *
 * Overrides: with an open deal the panel shows the deal's current values and offers an inline editor
 * per row that will not save without a changed, valid value and a reason — the reason is what the
 * parser learns from.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ParsedFieldsPanel } from "@/components/pipeline/ParsedFieldsPanel";
import { emptyFields } from "@/lib/pipeline/omsSchema";
import type { DealRecord, EmailRecord, FieldOverride } from "@/lib/pipeline/types";

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

/** The deal the email's parse staged, with `fields` overridable per test. */
function deal(over: Partial<DealRecord> = {}): DealRecord {
  const parse = email().parse!;
  return {
    deal_id: "dl_1",
    email_id: "em_1",
    opportunity_name: parse.fields.opportunity_name,
    status: "STAGED",
    fields: { ...parse.fields },
    original_fields: { ...parse.fields },
    evidence: parse.evidence,
    assumptions: parse.assumptions,
    memory_hits: parse.memory_hits,
    skills_used: parse.skills_used,
    enrichment: parse.enrichment,
    csv_key: "deal-csv/dl_1.csv",
    upload: null,
    history: [],
    created_at: "2026-08-05T13:59:00Z",
    updated_at: "2026-08-05T13:59:00Z",
    ...over,
  };
}

const agentOverride: FieldOverride = {
  override_id: "ov_1",
  field: "left_agent",
  parsed_value: "Silverline Partners",
  previous_value: "Silverline Partners",
  value: "Silverline",
  reason: "The desk books the bank's short name.",
  actor: "reviewer@example.test",
  at: "2026-08-05T14:10:00Z",
  stage: "review",
  memory: { status: "sent", event_id: "ev-1" },
};

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

describe("ParsedFieldsPanel overrides", () => {
  const overridden = () =>
    deal({ fields: { ...deal().fields, left_agent: "Silverline" }, overrides: [agentOverride] });

  it("shows the deal's current value and the override that explains it", () => {
    render(<ParsedFieldsPanel email={email()} deal={overridden()} onOverride={vi.fn()} />);
    expect(document.querySelector('[data-field="left_agent"]')).toHaveTextContent("Silverline");
    expect(document.querySelector('[data-field="left_agent"]')).not.toHaveTextContent("Partners");
    const note = document.querySelector('[data-override="left_agent"]') as HTMLElement;
    expect(note).toHaveTextContent("overridden");
    expect(note).toHaveTextContent("reviewer@example.test");
    expect(note).toHaveTextContent("The desk books the bank's short name.");
    expect(note).toHaveTextContent("lesson sent to memory");
  });

  it("saves only a changed, valid value with a reason, then closes the editor", async () => {
    const onOverride = vi.fn().mockResolvedValue(undefined);
    render(<ParsedFieldsPanel email={email()} deal={deal()} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole("button", { name: "Override Left Agent" }));
    const editor = screen.getByRole("group", { name: "Override Left Agent" });
    const save = within(editor).getByRole("button", { name: "Save override" });
    expect(within(editor).getByText("Silverline Partners")).toBeTruthy(); // the parsed value beside it
    expect(save).toBeDisabled(); // nothing changed yet

    fireEvent.change(within(editor).getByLabelText("Left Agent"), { target: { value: "Silverline" } });
    expect(save).toBeDisabled(); // changed, but no reason
    fireEvent.change(within(editor).getByLabelText("Reason for overriding Left Agent"), {
      target: { value: "  The desk books the bank's short name.  " },
    });
    expect(save).toBeEnabled();

    await act(async () => fireEvent.click(save));
    // The only order of a single-order deal.
    expect(onOverride).toHaveBeenCalledWith("left_agent", "Silverline", "The desk books the bank's short name.", [0]);
    expect(screen.queryByRole("group", { name: "Override Left Agent" })).toBeNull();
  });

  it("names a value the OMS would reject and will not save it", () => {
    render(<ParsedFieldsPanel email={email()} deal={deal()} onOverride={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Override Issue Size (MM)" }));
    const editor = screen.getByRole("group", { name: "Override Issue Size (MM)" });
    fireEvent.change(within(editor).getByLabelText("Issue Size (MM)"), { target: { value: "1295" } });
    fireEvent.change(within(editor).getByLabelText(/Reason for overriding/), { target: { value: "r" } });
    expect(within(editor).getByRole("alert")).toHaveTextContent(/millions/);
    expect(within(editor).getByRole("button", { name: "Save override" })).toBeDisabled();
  });

  it("keeps the editor open with the error when the save is refused", async () => {
    const onOverride = vi.fn().mockRejectedValue(new Error("deal dl_1 changed while this edit was in flight"));
    render(<ParsedFieldsPanel email={email()} deal={deal()} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole("button", { name: "Override Left Agent" }));
    const editor = screen.getByRole("group", { name: "Override Left Agent" });
    fireEvent.change(within(editor).getByLabelText("Left Agent"), { target: { value: "Silverline" } });
    fireEvent.change(within(editor).getByLabelText(/Reason for overriding/), { target: { value: "r" } });
    await act(async () => fireEvent.click(within(editor).getByRole("button", { name: "Save override" })));
    expect(within(editor).getByRole("alert")).toHaveTextContent(/changed while this edit was in flight/);
    expect(within(editor).getByRole("button", { name: "Save override" })).toBeEnabled();
  });

  it("is read-only, and says why, when the deal can no longer be edited", () => {
    render(<ParsedFieldsPanel email={email()} deal={{ ...overridden(), status: "UPLOADED" }} />);
    expect(screen.getByText(/Values are read-only: the deal is uploaded/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Override / })).toBeNull();
    // The override still explains the value it set.
    expect(document.querySelector('[data-override="left_agent"]')).toBeTruthy();
  });

  it("offers no editor without a deal", () => {
    render(<ParsedFieldsPanel email={email()} />);
    expect(screen.queryByRole("button", { name: /^Override / })).toBeNull();
  });

  it("offers the lesson's retract only where the screen allows it, and asks first", async () => {
    const onRetract = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ParsedFieldsPanel email={email()} deal={overridden()} onRetract={() => onRetract} />,
    );
    const note = () => document.querySelector('[data-override="left_agent"]') as HTMLElement;
    fireEvent.click(within(note()).getByRole("button", { name: "retract lesson" }));
    const confirm = within(note()).getByRole("group", { name: "Retract this lesson" });
    expect(confirm).toHaveTextContent("the value stays on this deal");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "retract" })));
    expect(onRetract).toHaveBeenCalledWith(agentOverride);
    expect(within(note()).queryByRole("group", { name: "Retract this lesson" })).toBeNull();

    // Not the viewer's to retract: no action at all.
    rerender(<ParsedFieldsPanel email={email()} deal={overridden()} onRetract={() => undefined} />);
    expect(within(note()).queryByRole("button", { name: "retract lesson" })).toBeNull();

    // A lesson already retracted says so, and who did it.
    const gone = deal({
      fields: { ...deal().fields, left_agent: "Silverline" },
      overrides: [{ ...agentOverride, memory: { status: "retracted", retracted_by: "admin-1", retracted_at: "2026-08-06T10:00:00Z" } }],
    });
    rerender(<ParsedFieldsPanel email={email()} deal={gone} onRetract={() => onRetract} />);
    expect(within(note()).getByText("lesson retracted").getAttribute("title")).toMatch(/^retracted by admin-1/);
    expect(within(note()).queryByRole("button", { name: "retract lesson" })).toBeNull();
  });

  it("keeps a refused retract on screen with its reason", async () => {
    const onRetract = vi.fn().mockRejectedValue(new Error("no lesson record carries this override yet"));
    render(<ParsedFieldsPanel email={email()} deal={overridden()} onRetract={() => onRetract} />);
    const note = document.querySelector('[data-override="left_agent"]') as HTMLElement;
    fireEvent.click(within(note).getByRole("button", { name: "retract lesson" }));
    await act(async () => fireEvent.click(within(note).getByRole("button", { name: "retract" })));
    expect(within(note).getByRole("alert")).toHaveTextContent(/no lesson record carries this override yet/);
    expect(within(note).getByRole("group", { name: "Retract this lesson" })).toBeTruthy();
  });
});

describe("ParsedFieldsPanel with several orders", () => {
  const usd = { ...deal().fields, currency: "USD", maturity_terms: "5 yr" };
  const eur = { ...deal().fields, currency: "EUR", maturity_terms: "8 yr" };
  const twoOrders = () =>
    deal({
      fields: usd,
      original_fields: usd,
      orders: [
        { label: "USD 5yr", fields: usd, original_fields: usd, evidence: {} },
        { label: "EUR 8yr", fields: eur, original_fields: eur, evidence: {}, assumptions: ["EUR size TBD."] },
      ],
    });

  it("shows one order at a time, with shared values apart from that order's own", () => {
    render(<ParsedFieldsPanel email={email()} deal={twoOrders()} />);
    expect(screen.getByText(/2 orders from this email/)).toBeTruthy();
    const shared = document.querySelector('[data-group="shared"]') as HTMLElement;
    const own = document.querySelector('[data-group="order"]') as HTMLElement;
    expect(shared).toHaveTextContent("Shared by all 2 orders");
    expect(within(shared).getByText("Silverline Partners")).toBeTruthy(); // same in both
    expect(within(shared).queryByText("USD")).toBeNull();
    expect(own).toHaveTextContent("This order · 1 · USD 5yr");
    expect(within(own).getByText("USD")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /2 · EUR 8yr/ }));
    expect(document.querySelector('[data-group="order"]')).toHaveTextContent("This order · 2 · EUR 8yr");
    expect(within(document.querySelector('[data-group="order"]') as HTMLElement).getByText("EUR")).toBeTruthy();
    expect(screen.getByText("EUR size TBD.")).toBeTruthy(); // the order's own assumptions
  });

  it("asks whether a shared override applies to every order, and saves the scope chosen", async () => {
    const onOverride = vi.fn().mockResolvedValue(undefined);
    render(<ParsedFieldsPanel email={email()} deal={twoOrders()} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole("button", { name: /2 · EUR 8yr/ }));

    const edit = async (label: string, value: string, onlyThis = false) => {
      fireEvent.click(screen.getByRole("button", { name: `Override ${label}` }));
      const editor = screen.getByRole("group", { name: `Override ${label}` });
      fireEvent.change(within(editor).getByLabelText(label), { target: { value } });
      fireEvent.change(within(editor).getByLabelText(/Reason for overriding/), { target: { value: "r" } });
      if (onlyThis) fireEvent.click(within(editor).getByLabelText("this order only"));
      await act(async () => fireEvent.click(within(editor).getByRole("button", { name: "Save override" })));
    };

    // Shared: all orders by default — one override covering both.
    await edit("Left Agent", "Silverline");
    expect(onOverride).toHaveBeenLastCalledWith("left_agent", "Silverline", "r", [0, 1]);
    // Shared, narrowed to this order.
    await edit("Left Agent", "Silverline", true);
    expect(onOverride).toHaveBeenLastCalledWith("left_agent", "Silverline", "r", [1]);
    // This order's own field: no scope to choose, always this order.
    fireEvent.click(screen.getByRole("button", { name: "Override Maturity Terms" }));
    expect(within(screen.getByRole("group", { name: "Override Maturity Terms" })).queryByText("Apply to")).toBeNull();
  });

  it("counts each order's overrides and OMS errors on its chip", () => {
    const d = twoOrders();
    d.status = "UPLOAD_FAILED";
    d.upload = {
      attempted_at: "t",
      accepted: false,
      staging_key: null,
      errors: [{ code: "COVENANT_STATUS_REQUIRED", field: "covenant_status_num", message: "m", row: 1 }],
      validator_version: "1",
    };
    d.overrides = [{ ...agentOverride, order_indexes: [0, 1] }];
    render(<ParsedFieldsPanel email={email()} deal={d} />);
    const eurChip = screen.getByRole("button", { name: /2 · EUR 8yr/ });
    expect(eurChip).toHaveTextContent("✎1");
    expect(eurChip).toHaveTextContent("✕1");
    expect(screen.getByRole("button", { name: /1 · USD 5yr/ })).not.toHaveTextContent("✕");
  });
});

