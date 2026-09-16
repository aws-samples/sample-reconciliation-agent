/**
 * The case detail page, from the token-usage / run-cost angle only.
 *
 * `__tests__/lib/modelPricing.test.ts` already pins the arithmetic, so nothing here re-checks a
 * multiplication. What only a render can check is the four-way display contract, and three of the
 * four are ways of NOT showing a number:
 *
 *   - a case with no measured usage — which is every case investigated before the attribute shipped —
 *     must render NOTHING on the trace header. Not `0`, not an em dash. That is the assertion this
 *     file exists for, and it is written as "the header row's text is exactly the step count" rather
 *     than as "the page still renders", because the failure mode is a zero appearing, not a crash;
 *   - a model with no published rate must show its tokens and NO dollar figure. Asserted as "no `$`
 *     anywhere in that row", since the bug to prevent is a `$0.00` that reads as a free run;
 *   - an absent cache count must render blank, never `0`: Bedrock omits those keys on an uncached
 *     call, so `CACHED 0` would claim a measurement nobody made.
 *
 * The fourth is the floor marker, which has to appear when a cache write was reported and must NOT
 * appear otherwise — a caveat shown on every row is a caveat operators stop reading.
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

// `@/lib/modelPricing` is deliberately NOT mocked: the rate table is the thing being displayed, and
// a stubbed price would let a formatting bug through while asserting a number this page never shows.
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

/**
 * An escalated case with a two-step trace, one of which invoked a tool.
 *
 * The tool call is load-bearing for the test rig, not for the feature: it makes the skill panel's
 * one-line summary read "2 steps · tools: search_notices", which keeps {@link traceHeaderRow}'s
 * exact-match query on "2 steps" unambiguous.
 */
function investigated(over: Partial<ReconCase> = {}): ReconCase {
  return {
    item_id: "i-cost",
    status: "PROPOSED",
    tier: 2,
    class_id: "short-payment",
    steps: [
      { skill: "short-payment", reasoning: "looked", evidence: [] },
      {
        skill: "short-payment",
        reasoning: "searched",
        evidence: [],
        kind: "tool_call",
        tool: "search_notices",
      },
    ],
    ...over,
  };
}

/** Sonnet, whose published rates are $2/$10/$2.50/$0.20 per MTok. */
const SONNET = "us.anthropic.claude-sonnet-5";

async function show(recon: ReconCase) {
  getCase.mockResolvedValue(recon);
  render(<CasePage params={routeParams({ id: recon.item_id })} />);
  await screen.findByText(recon.item_id);
}

/**
 * The Agent Trace panel's header line: step count, token figures and cost, all on one row.
 *
 * Found via the step-count span rather than by class selector so a styling change cannot silently
 * turn every assertion below into a no-op. Filtered to a SPAN because the skill panel renders its own
 * "N steps …" summary in a div.
 */
function traceHeaderRow(): HTMLElement {
  const stepCount = screen
    .getAllByText(/^\d+ steps?$/)
    .find((el) => el.tagName === "SPAN");
  if (!stepCount) throw new Error("no trace-header step count span rendered");
  const row = stepCount.parentElement;
  if (!row) throw new Error("trace-header step count has no parent row");
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({ commentRequirement: "optional" });
  listContactSummaries.mockResolvedValue([]);
});

describe("case detail — the agent run's tokens and cost", () => {
  it("shows the token totals and the priced cost beside the step count", async () => {
    await show(
      investigated({
        token_usage: {
          input_tokens: 12400,
          output_tokens: 1180,
          cache_read_tokens: 8000,
          model_id: SONNET,
          backend: "harness",
        },
      }),
    );

    // 12400 × $2 + 1180 × $10 + 8000 × $0.20, all per MTok = 0.0248 + 0.0118 + 0.0016.
    const amount = screen.getByText("$0.0382");
    const row = traceHeaderRow();
    expect(row.textContent).toContain("IN 12,400");
    expect(row.textContent).toContain("OUT 1,180");
    expect(row.textContent).toContain("CACHED 8,000");
    // Still one line beside the step count, not a panel of its own.
    expect(row.textContent).toContain("2 steps");
    // The figure says what it is, and which rate table row produced it — a bare number beside a trace
    // would read as a billed amount rather than an estimate.
    expect(amount.getAttribute("title")).toContain("An estimate at today's");
    expect(amount.getAttribute("title")).toContain(SONNET);
    // And that it is recomputed rather than stored, so a changed figure on an old case is expected.
    expect(amount.getAttribute("title")).toContain("re-prices");
  });

  it("renders nothing at all when the run was never measured", async () => {
    // The pre-change case: `token_usage` was not an attribute when this row was written. Absence is
    // not zero, so the header must look exactly as it did before this feature existed.
    await show(investigated());

    expect(traceHeaderRow().textContent).toBe("2 steps");
    expect(screen.queryByText(/CACHED/)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/NO RATE FOR/)).toBeNull();
    expect(screen.queryByText(/NO MODEL RECORDED/)).toBeNull();
  });

  it("shows the tokens and no dollar figure when the model has no published rate", async () => {
    await show(
      investigated({
        token_usage: {
          input_tokens: 12400,
          output_tokens: 1180,
          model_id: "us.anthropic.claude-nonesuch-9",
          backend: "runtime",
        },
      }),
    );

    const row = traceHeaderRow();
    expect(row.textContent).toContain("IN 12,400");
    expect(row.textContent).toContain("OUT 1,180");
    // The whole point: the tokens were consumed and cost something, so no amount may be invented.
    expect(row.textContent).not.toContain("$");
    // And the gap is named, so it is actionable rather than mysteriously blank.
    expect(row.textContent).toContain(
      "NO RATE FOR us.anthropic.claude-nonesuch-9",
    );
  });

  it("omits the cached figure entirely when no cache counts were reported", async () => {
    await show(
      investigated({
        token_usage: {
          input_tokens: 12400,
          output_tokens: 1180,
          model_id: SONNET,
          backend: "harness",
        },
      }),
    );

    const row = traceHeaderRow();
    expect(row.textContent).toContain("IN 12,400");
    expect(row.textContent).toContain("OUT 1,180");
    // Not "CACHED 0": the provider omitted the keys, so nothing about caching was measured.
    expect(row.textContent).not.toContain("CACHED");
    expect(row.textContent).not.toContain("0 read");
    expect(screen.getByText("$0.0366")).toBeTruthy();
  });

  it("marks the amount as a floor when a cache write was reported, and not otherwise", async () => {
    await show(
      investigated({
        token_usage: {
          input_tokens: 12400,
          output_tokens: 1180,
          cache_read_tokens: 8000,
          cache_write_tokens: 4000,
          model_id: SONNET,
          backend: "harness",
        },
      }),
    );

    // 0.0382 as above, plus 4000 × $2.50 per MTok priced at the 5-minute rate = 0.0100.
    expect(screen.getByText(/≥\s*\$0\.0482/)).toBeTruthy();
    // Both cache counts fold into one CACHED figure; the split lives in that span's tooltip.
    const cached = screen.getByText(/CACHED 12,000/);
    expect(cached.getAttribute("title")).toContain(
      "8,000 read + 4,000 written",
    );
    // The caveat has to reach the reader of the number, so it is on the amount, not only in a comment.
    const amount = screen.getByText(/≥\s*\$0\.0482/);
    expect(amount.getAttribute("title")).toContain("5-minute rate");
  });

  it("does not mark the amount as a floor when only a cache read was reported", async () => {
    await show(
      investigated({
        token_usage: {
          input_tokens: 12400,
          output_tokens: 1180,
          cache_read_tokens: 8000,
          model_id: SONNET,
          backend: "harness",
        },
      }),
    );

    // A read carries no 5m/1h ambiguity, so the estimate is exact against the table and unhedged.
    expect(traceHeaderRow().textContent).not.toContain("≥");
  });

  it("keeps a sub-cent run legible instead of rounding it to zero", async () => {
    // The precision rule under load: two decimal places would render this run — which really happened
    // and really cost money — as "$0.00", the exact misreading the four-place rule exists to prevent.
    await show(
      investigated({
        token_usage: {
          input_tokens: 1,
          output_tokens: 1,
          model_id: SONNET,
          backend: "harness",
        },
      }),
    );

    // 1 × $2 + 1 × $10 per MTok = $0.000012, below four places, so it gains digits rather than losing
    // the figure.
    expect(screen.getByText("$0.00001")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("prices a case the DynamoDB round trip handed back as strings", async () => {
    // What actually arrives: `unmarshall` plus `NextResponse.json` can turn a Decimal count into a
    // string, and a string multiplied by a rate is NaN dollars. Pinned here because the page passes
    // the stored object straight through — nothing between the wire and the rate table coerces it.
    await show(
      investigated({
        token_usage: {
          input_tokens: "12400",
          output_tokens: "1180",
          model_id: SONNET,
          backend: "runtime",
        },
      }),
    );

    expect(screen.getByText("$0.0366")).toBeTruthy();
    expect(traceHeaderRow().textContent).toContain("IN 12,400");
    expect(traceHeaderRow().textContent).not.toContain("NaN");
  });
});
