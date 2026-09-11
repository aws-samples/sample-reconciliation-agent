/**
 * The two inbox pages, at the point where they poll.
 *
 * Both re-read their record every few seconds while it is RECEIVED or PARSING, and both draw the error
 * state ahead of the data. So the property to pin is recovery: one failed poll must not leave the page
 * saying "failed to load" after the next poll has brought the data back — during the demo that is the
 * exact window a viewer is watching.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailRecord } from "@/lib/pipeline/types";

const listEmails = vi.fn();
const getEmail = vi.fn();
vi.mock("@/lib/pipelineApi", () => ({
  listEmails: (...a: unknown[]) => listEmails(...a),
  getEmail: (...a: unknown[]) => getEmail(...a),
  reparseEmail: vi.fn(),
  listSamples: vi.fn(),
  createEmail: vi.fn(),
}));
vi.mock("@/hooks/usePipelineSubject", () => ({
  usePipelineSubject: () => ({ subject: "sub-1", groups: [], isAdmin: false }),
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
});
