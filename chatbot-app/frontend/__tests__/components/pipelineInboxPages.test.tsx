/**
 * The two inbox pages, at the point where they poll.
 *
 * Both re-read their record every few seconds while it is RECEIVED or PARSING, and both draw the error
 * state ahead of the data. So the property to pin is recovery: one failed poll must not leave the page
 * saying "failed to load" after the next poll has brought the data back — during the demo that is the
 * exact window a viewer is watching.
 *
 * The detail page also loads the deal its parse staged, so the panel shows current values and can
 * override them while the deal is open — and only then.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyFields } from "@/lib/pipeline/omsSchema";
import type { DealRecord, EmailRecord } from "@/lib/pipeline/types";

const listEmails = vi.fn();
const getEmail = vi.fn();
const getDeal = vi.fn();
const updateDealFields = vi.fn();
vi.mock("@/lib/pipelineApi", () => ({
  listEmails: (...a: unknown[]) => listEmails(...a),
  getEmail: (...a: unknown[]) => getEmail(...a),
  getDeal: (...a: unknown[]) => getDeal(...a),
  updateDealFields: (...a: unknown[]) => updateDealFields(...a),
  reparseEmail: vi.fn(),
  listSamples: vi.fn(),
  createEmail: vi.fn(),
}));
vi.mock("@/hooks/useAppSubject", () => ({
  useAppSubject: () => ({ subject: "sub-1", groups: [], isAdmin: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The detail page reads its route params through React's `use`, which the React 18 in this test
// environment does not have (the app runs on the copy Next bundles). Resolve a `{ value }` stand-in
// synchronously so the page renders without a Suspense boundary.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, use: (p: unknown) => (p as { value: unknown }).value };
});

import InboxPage from "@/app/pipeline/inbox/page";
import EmailDetailPage from "@/app/pipeline/inbox/[id]/page";

/** Matches the pages' own poll interval. */
const POLL_MS = 3000;

function email(over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    email_id: "em_1",
    received_at: "2026-08-05T13:58:00Z",
    source_kind: "bank-notice",
    from: "Syndicated Finance <syndicate@silverlinepartners.example>",
    to: "New Issues Desk <new-issues@example-firm.test>",
    subject: "Copperfield Insurance Partners - $1,295MM Term Loan B Refinancing - Launch",
    sent: "2026-08-05T13:41:00Z",
    body: "Facility:            $1,295 million Term Loan B",
    sample_id: "06-bank-notice-copperfield-insurance-tlb",
    status: "PARSING",
    deal_id: null,
    error: null,
    updated_at: "2026-08-05T13:59:00Z",
    parse: null,
    ...over,
  };
}

/** Let the mocked fetch settle and React commit, then move the clock on by `ms`. */
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  listEmails.mockReset();
  getEmail.mockReset();
  getDeal.mockReset();
  updateDealFields.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InboxPage", () => {
  it("clears a stale error once a later poll succeeds", async () => {
    listEmails
      .mockResolvedValueOnce([email({ status: "PARSING" })])
      .mockRejectedValueOnce(new Error("pipeline API error 500"))
      .mockResolvedValueOnce([email({ status: "PARSE_FAILED", error: "model timed out" })]);
    render(<InboxPage />);

    await tick();
    expect(screen.getByText("1 email · parsing…")).toBeTruthy();
    expect(document.querySelector('[data-status="PARSING"]')).toBeTruthy();

    // One transient failure mid-poll: the error shows, as it should.
    await tick(POLL_MS);
    expect(
      screen.getByText("Failed to load the inbox — Error: pipeline API error 500"),
    ).toBeTruthy();

    // The next poll succeeds and the table comes back; the error must go with it.
    await tick(POLL_MS);
    expect(listEmails).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Failed to load the inbox/)).toBeNull();
    expect(document.querySelector('[data-status="PARSE_FAILED"]')).toBeTruthy();
  });
});

describe("EmailDetailPage", () => {
  const params = { value: { id: "em_1" } } as unknown as Promise<{ id: string }>;

  it("clears a stale error once a later poll succeeds", async () => {
    getEmail
      .mockResolvedValueOnce(email({ status: "PARSING" }))
      .mockRejectedValueOnce(new Error("pipeline API error 500"))
      .mockResolvedValueOnce(email({ status: "PARSE_FAILED", error: "model timed out" }));
    render(<EmailDetailPage params={params} />);

    await tick();
    expect(screen.getByText(/the parsing agent is reading the email/)).toBeTruthy();

    await tick(POLL_MS);
    expect(
      screen.getByText("Failed to load the email — Error: pipeline API error 500"),
    ).toBeTruthy();

    // Parsing has finished by the next poll, so nothing would ever retry after this one: the
    // recovered read has to clear the error itself.
    await tick(POLL_MS);
    expect(getEmail).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Failed to load the email/)).toBeNull();
    expect(screen.getByText(/Parse failed — model timed out/)).toBeTruthy();
  });

  const parsedFields = { ...emptyFields(), pipeline_type: "Loan", left_agent: "Silverline Partners" };
  const parsed = () =>
    email({
      status: "PARSED",
      deal_id: "dl_1",
      parse: {
        fields: parsedFields,
        evidence: {},
        assumptions: [],
        memory_hits: [],
        skills_used: [],
        enrichment: { issuer_match: null, fields_from_security_master: [] },
        model_id: "m",
        duration_ms: 1,
      },
    });
  const stagedDeal = (over: Partial<DealRecord> = {}): DealRecord => ({
    deal_id: "dl_1",
    email_id: "em_1",
    opportunity_name: "",
    status: "STAGED",
    fields: { ...parsedFields },
    original_fields: { ...parsedFields },
    evidence: {},
    assumptions: [],
    memory_hits: [],
    skills_used: [],
    enrichment: { issuer_match: null, fields_from_security_master: [] },
    csv_key: "deal-csv/dl_1.csv",
    upload: null,
    history: [],
    created_at: "t",
    updated_at: "t",
    ...over,
  });

  it("overrides one value on the staged deal and shows the deal the route returned", async () => {
    getEmail.mockResolvedValue(parsed());
    getDeal.mockResolvedValue(stagedDeal());
    updateDealFields.mockResolvedValue(
      stagedDeal({
        fields: { ...parsedFields, left_agent: "Silverline" },
        overrides: [
          {
            override_id: "ov_1",
            field: "left_agent",
            parsed_value: "Silverline Partners",
            previous_value: "Silverline Partners",
            value: "Silverline",
            reason: "short name",
            actor: "sub-1",
            at: "t",
            stage: "review",
            memory: { status: "sent", event_id: "ev-1" },
          },
        ],
      }),
    );
    render(<EmailDetailPage params={params} />);
    await tick();
    expect(getDeal).toHaveBeenCalledWith("dl_1");

    fireEvent.click(screen.getByRole("button", { name: "Override Left Agent" }));
    const editor = screen.getByRole("group", { name: "Override Left Agent" });
    fireEvent.change(within(editor).getByLabelText("Left Agent"), { target: { value: "Silverline" } });
    fireEvent.change(within(editor).getByLabelText(/Reason for overriding/), { target: { value: "short name" } });
    await act(async () => fireEvent.click(within(editor).getByRole("button", { name: "Save override" })));

    expect(updateDealFields).toHaveBeenCalledWith("dl_1", { left_agent: "Silverline" }, { left_agent: "short name" });
    expect(document.querySelector('[data-field="left_agent"]')).toHaveTextContent("Silverline");
    expect(document.querySelector('[data-override="left_agent"]')).toHaveTextContent("lesson sent to memory");
  });

  it("offers no override once the deal has left review, nor when the deal cannot be read", async () => {
    getEmail.mockResolvedValue(parsed());
    getDeal.mockResolvedValueOnce(stagedDeal({ status: "UPLOADED" }));
    const { unmount } = render(<EmailDetailPage params={params} />);
    await tick();
    expect(screen.getByText(/Values are read-only: the deal is uploaded/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Override / })).toBeNull();
    unmount();

    getDeal.mockRejectedValueOnce(new Error("pipeline API error 500"));
    render(<EmailDetailPage params={params} />);
    await tick();
    expect(screen.getByText(/Could not load deal dl_1, so values are shown as parsed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Override / })).toBeNull();
  });
});
