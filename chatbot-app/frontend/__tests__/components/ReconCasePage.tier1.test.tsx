/**
 * The case detail page, from the Tier-1 auto-clear angle only.
 *
 * The page was written for the escalated path and reused verbatim for the deterministic one, so a
 * case the deterministic tier resolved rendered every agent panel empty — and the proposed-action
 * panel told the operator the case "escalates for a human decision", which is the exact opposite of
 * what happened. The platform's best outcome, straight-through with no model and no human, was the
 * one screen it could not account for.
 *
 * The suppression is gated on `tier`, never on the agent fields being empty, and the third test here
 * is the one that matters: a Tier-2 case with no trace and no proposal must keep every agent panel,
 * because for that case the emptiness IS the finding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReconCase } from "@/lib/reconApi";

/** See ReconCasePage.draft.test.tsx — the pinned React does not export `use`. */
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    use: (value: unknown) => {
      if (!value || !(typeof value === "object") || !("__resolved" in value)) {
        throw new Error("stubbed `use` only accepts a routeParams() promise");
      }
      return (value as { __resolved: unknown }).__resolved;
    },
  };
});

function routeParams(value: { id: string }): Promise<{ id: string }> {
  return Object.assign(Promise.resolve(value), { __resolved: value });
}

const getCase = vi.fn();
const getConfig = vi.fn();
const listContactSummaries = vi.fn();

vi.mock("@/lib/reconApi", () => ({
  getCase,
  getConfig,
  listContactSummaries,
  getCaseEvals: vi.fn().mockResolvedValue({ records: [] }),
  approveCase: vi.fn(),
  rejectCase: vi.fn(),
  retryCase: vi.fn(),
  cancelCase: vi.fn(),
  decideEmailDraft: vi.fn(),
  saveEmailDraft: vi.fn(),
}));
vi.mock("@/lib/reconToken", () => ({
  getStoredAccessToken: () => "tok",
}));

const CasePage = (await import("@/app/recon/case/[id]/page")).default;

/** A case the deterministic rule cleared, with the comparison it made. */
function ruleCleared(over: Partial<ReconCase> = {}): ReconCase {
  return {
    item_id: "i-auto",
    status: "AUTO_CLEARED",
    tier: 1,
    category: "amount-match",
    tier1_match: {
      matched_on: "rule",
      rule_domain: "cash",
      match_attr: "amount",
      tolerance: "0.05",
      side_a_name: "bank",
      side_b_name: "ledger",
      side_a_value: "100.00",
      side_b_value: "100.02",
      difference: "0.02",
    },
    ...over,
  };
}

async function show(recon: ReconCase) {
  getCase.mockResolvedValue(recon);
  render(<CasePage params={routeParams({ id: recon.item_id })} />);
  await screen.findByText(recon.item_id);
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({ commentRequirement: "optional" });
  listContactSummaries.mockResolvedValue([]);
});

describe("case detail — a Tier-1 auto-cleared case", () => {
  it("shows the rule, both compared values and the margin", async () => {
    await show(ruleCleared());

    expect(screen.getByText(/Tier-1 Deterministic Resolution/i)).toBeTruthy();
    expect(screen.getByText("amount-match")).toBeTruthy();
    expect(screen.getByText("100.00")).toBeTruthy();
    expect(screen.getByText("100.02")).toBeTruthy();
    // The margin is reported exactly. A float round-trip would render 0.020000000000000018, which
    // reads as a precision fault in the reconciliation rather than in the display.
    expect(screen.getByText("0.02")).toBeTruthy();
    expect(screen.getByText("0.05")).toBeTruthy();
  });

  it("never claims the case escalates for a human decision", async () => {
    await show(ruleCleared());

    expect(screen.queryByText(/escalates for a human decision/i)).toBeNull();
    expect(screen.queryByText(/Evidence Score/i)).toBeNull();
    expect(screen.queryByText(/Agent Trace/i)).toBeNull();
    expect(screen.queryByText(/No investigation steps recorded/i)).toBeNull();
    expect(
      screen.queryByText(/No evidence steps were reported for this case/i),
    ).toBeNull();
  });

  it("names the matched ledger row when the general ledger cleared it", async () => {
    await show(
      ruleCleared({
        item_id: "i-gl",
        category: "gl-match",
        tier1_match: {
          matched_on: "general_ledger",
          borrower: "ACME LTD",
          entry_type: "CREDIT",
          tolerance: "0.05",
          extracted_amount: "500.00",
          ledger_amount: "500.00",
          difference: "0.00",
          candidates_considered: "3",
          ledger_rows_returned: "7",
          ledger_row: { entry_id: "GL-1", amount: "500.00" },
        },
      }),
    );

    expect(screen.getByText(/Matched Ledger Row/i)).toBeTruthy();
    expect(screen.getByText("GL-1")).toBeTruthy();
    expect(screen.getByText("ACME LTD")).toBeTruthy();
    expect(screen.getByText("CREDIT")).toBeTruthy();
  });

  it("says the detail is unavailable rather than inventing a zero margin", async () => {
    // A case cleared before the evidence attribute existed. These are the cases an operator opens
    // first when judging whether this fix worked, so they must render — and an absent measurement
    // and a measurement of zero mean opposite things here.
    await show(ruleCleared({ tier1_match: null }));

    expect(screen.getByText(/Tier-1 Deterministic Resolution/i)).toBeTruthy();
    expect(
      screen.getByText(/comparison detail was not recorded/i),
    ).toBeTruthy();
    expect(screen.queryByText("0.00")).toBeNull();
  });
});

describe("case detail — a Tier-2 case is untouched by the suppression", () => {
  it("keeps the agent panels and their empty states when the agent found nothing", async () => {
    // The whole point of gating on `tier` rather than on emptiness. This case looks identical to an
    // auto-clear from the agent fields alone, but here the emptiness is the finding.
    await show({
      item_id: "i-empty",
      status: "PROPOSED",
      tier: 2,
      class_id: "unknown",
      steps: [],
      proposed_action: null,
    });

    // getAllByText: "Evidence Score" appears as the panel eyebrow and again inside sibling panels'
    // tooltip copy, which cross-reference it.
    expect(screen.getAllByText(/Evidence Score/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agent Trace/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/No investigation steps recorded/i)).toBeTruthy();
    expect(screen.getByText(/escalates for a human decision/i)).toBeTruthy();
    expect(screen.queryByText(/Tier-1 Deterministic Resolution/i)).toBeNull();
  });
});
