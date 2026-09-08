/**
 * The case detail page, from the counterparty-draft angle only.
 *
 * Two behaviours live in the page rather than in the panel, and neither is visible from a unit test
 * of either piece: a case whose draft is still `pending` must not be approvable (RESOLVED is
 * terminal, so approving would strand the draft unsendable on a case that reads as closed), and an
 * approved draft turns the case approval into a send, which the button has to say out loud and the
 * request has to pin to a revision.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { EmailDraft, ReconCase } from "@/lib/reconApi";

/**
 * The page reads its route params with React's `use(promise)`, which the pinned React (18.3.1 in
 * node_modules — Next resolves its own copy when it builds) does not export, so rendering the page
 * unmocked dies with "use is not a function" before any assertion runs. Standing in a hook that
 * unwraps a promise built by {@link routeParams} keeps the page's own code untouched; it refuses
 * anything else rather than quietly returning undefined and producing a confusing render.
 */
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

/** A params promise the stubbed `use` above can unwrap synchronously. */
function routeParams(value: { id: string }): Promise<{ id: string }> {
  return Object.assign(Promise.resolve(value), { __resolved: value });
}

const approveCase = vi.fn();
const decideEmailDraft = vi.fn();
const saveEmailDraft = vi.fn();
const getCase = vi.fn();
const getConfig = vi.fn();
const listContactSummaries = vi.fn();

vi.mock("@/lib/reconApi", () => ({
  approveCase,
  decideEmailDraft,
  saveEmailDraft,
  getCase,
  getConfig,
  listContactSummaries,
  getCaseEvals: vi.fn().mockResolvedValue({ records: [] }),
  rejectCase: vi.fn(),
  retryCase: vi.fn(),
  cancelCase: vi.fn(),
}));
vi.mock("@/lib/reconToken", () => ({
  getStoredAccessToken: () => "tok",
}));

const CasePage = (await import("@/app/recon/case/[id]/page")).default;

function draft(over: Partial<EmailDraft> = {}): EmailDraft {
  return {
    // The stored row names WHO, not where — the address is resolved from the contact id at send time.
    recipient: null,
    recipient_contact_id: "cp-ap",
    recipient_hint: "Counterparty AP",
    subject: "Invoice 42 — short payment",
    body: "We received 900.00 against invoice 42.",
    draft_status: "pending",
    revision: 4,
    approved_revision: null,
    edited_by: null,
    edited_at: null,
    approved_by: null,
    approved_at: null,
    discarded_by: null,
    discarded_at: null,
    send_attempted_at: null,
    sent_at: null,
    ...over,
  };
}

function reconCase(email: EmailDraft | null): ReconCase {
  return {
    item_id: "i-1",
    status: "PROPOSED",
    class_id: "SHORT_PAY",
    resolution: "Contact the counterparty",
    confidence: "0.88",
    proposed_email: email,
  };
}

/** Render the page and wait for the case fetch and the contact fetch to land. */
async function show(email: EmailDraft | null) {
  getCase.mockResolvedValue(reconCase(email));
  render(<CasePage params={routeParams({ id: "i-1" })} />);
  // Anchored: with a pending draft the panel contributes an "Approve draft" button too, and this
  // helper wants the case-level one.
  const approve = await screen.findByRole("button", {
    name: /^Approve( & send)?$/,
  });
  // The recipient list arrives on its own promise; without this the panel would still be rendering
  // with the fail-safe empty list, where the stored contact id reads as one that no longer exists.
  await waitFor(() => expect(listContactSummaries).toHaveBeenCalled());
  return approve;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({
    commentRequirement: "optional",
    counterpartyEmailDomains: ["counterparty.example"],
  });
  listContactSummaries.mockResolvedValue([
    {
      contact_id: "cp-ap",
      display_name: "Counterparty AP",
      kind: "counterparty",
      active: true,
    },
  ]);
  approveCase.mockResolvedValue({ status: "RESOLVED" });
  decideEmailDraft.mockResolvedValue({});
});

describe("case detail — approval with a counterparty draft", () => {
  it("blocks the case approval while the draft is pending, and says why", async () => {
    const approve = await show(draft());

    expect(approve).toHaveProperty("disabled", true);
    expect(approve.getAttribute("title")).toMatch(
      /approve or discard the draft first/,
    );
    fireEvent.click(approve);
    expect(approveCase).not.toHaveBeenCalled();
  });

  it("labels the approval a send, and pins it to the approved revision", async () => {
    const approve = await show(
      draft({ draft_status: "approved", approved_revision: 4 }),
    );

    expect(approve.textContent).toMatch(/Approve & send/);
    expect(approve).toHaveProperty("disabled", false);

    fireEvent.click(approve);
    await waitFor(() =>
      expect(approveCase).toHaveBeenCalledWith("i-1", undefined, {
        revision: 4,
        overrideUnknownSend: false,
      }),
    );
  });

  it("carries the analyst's unknown-send override into the approval", async () => {
    const approve = await show(
      draft({
        draft_status: "approved",
        approved_revision: 4,
        send_attempted_at: "2026-08-09T12:00:00.000Z",
      }),
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(approve);
    await waitFor(() =>
      expect(approveCase).toHaveBeenCalledWith("i-1", undefined, {
        revision: 4,
        overrideUnknownSend: true,
      }),
    );
  });

  it("sends no draft argument when there is no draft at all", async () => {
    const approve = await show(null);

    expect(approve.textContent).toMatch(/^Approve$/);
    expect(screen.queryByText("Counterparty Email Draft")).toBeNull();
    fireEvent.click(approve);
    await waitFor(() =>
      expect(approveCase).toHaveBeenCalledWith("i-1", undefined, undefined),
    );
  });

  it("approves a discarded draft's case normally", async () => {
    const approve = await show(
      draft({ draft_status: "discarded", discarded_by: "analyst@x.com" }),
    );

    expect(approve).toHaveProperty("disabled", false);
    expect(approve.textContent).toMatch(/^Approve$/);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(approveCase).toHaveBeenCalledWith("i-1", undefined, undefined),
    );
  });

  it("passes a draft decision through with the revision on display", async () => {
    await show(draft({ revision: 9 }));

    fireEvent.click(screen.getByRole("button", { name: /Discard draft/ }));
    await waitFor(() =>
      expect(decideEmailDraft).toHaveBeenCalledWith("i-1", "discard_draft", 9),
    );
  });

  it("feeds the recipient list to the panel, asking only for counterparties", async () => {
    await show(draft());
    // Two things at once. The kind argument matters: the analyst-facing endpoint would happily return
    // internal notification contacts, and offering one here would put a break email in front of a desk
    // that only ever receives resolution notices. And the panel resolving `cp-ap` to a name at all is
    // what proves the list reached it — with an empty list the same id reads as a removed contact.
    expect(listContactSummaries).toHaveBeenCalledWith("counterparty");
    const picker = screen.getByLabelText("Counterparty email recipient");
    expect(picker).toHaveProperty("value", "cp-ap");
    expect(
      screen.getByRole("option", { name: "Counterparty AP" }),
    ).toBeTruthy();
  });
});
