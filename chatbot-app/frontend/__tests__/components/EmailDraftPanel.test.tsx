/**
 * Render tests for the counterparty email draft panel.
 *
 * The panel is the only place a human decides what leaves the operator, so what these tests pin
 * down is which controls a given `draft_status` offers — and, more to the point, which it withholds.
 * An "Approve draft" button that is live while the textarea holds unsaved text would approve a
 * revision that does not exist; a plain retry offered after an unconfirmed send would offer to
 * double-send. Both are cheap to assert here and expensive to notice in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmailDraftPanel } from "@/components/recon/EmailDraftPanel";
import type { EmailDraft } from "@/lib/reconApi";

const DOMAINS = ["counterparty.example"];

function draft(over: Partial<EmailDraft> = {}): EmailDraft {
  return {
    recipient: "ap@counterparty.example",
    recipient_hint: "Counterparty AP",
    subject: "Invoice 42 — short payment",
    body: "We received 900.00 against invoice 42 for 1000.00.",
    draft_status: "pending",
    revision: 2,
    approved_revision: null,
    edited_by: "analyst@x.com",
    edited_at: "2026-08-09T09:30:00.000Z",
    approved_by: null,
    approved_at: null,
    discarded_by: null,
    discarded_at: null,
    send_attempted_at: null,
    sent_at: null,
    ...over,
  };
}

const onSave = vi.fn();
const onDecide = vi.fn();
const onOverrideChange = vi.fn();

function panel(
  over: Partial<EmailDraft> = {},
  props: Record<string, unknown> = {},
) {
  return render(
    <EmailDraftPanel
      draft={draft(over)}
      caseStatus="PROPOSED"
      allowedDomains={DOMAINS}
      onSave={onSave}
      onDecide={onDecide}
      onOverrideChange={onOverrideChange}
      {...props}
    />,
  );
}

const button = (name: RegExp) => screen.queryByRole("button", { name });
const recipientInput = () =>
  screen.getByLabelText("Counterparty email recipient");
const bodyInput = () => screen.getByLabelText("Counterparty email body");

beforeEach(() => {
  onSave.mockClear();
  onDecide.mockClear();
  onOverrideChange.mockClear();
});

describe("EmailDraftPanel — draft_status", () => {
  it("pending: offers save, approve and discard over editable fields", () => {
    panel();

    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("rev 2")).toBeTruthy();
    expect(recipientInput()).toBeTruthy();
    expect(button(/Save changes/)).toBeTruthy();
    expect(button(/Approve draft/)).toBeTruthy();
    expect(button(/Discard draft/)).toBeTruthy();
    // Nothing typed yet, so there is nothing to store.
    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", false);
  });

  it("pending: an edit enables save and disables approve, saying why", () => {
    panel();
    fireEvent.change(bodyInput(), { target: { value: "Reworded ask." } });

    expect(button(/Save changes/)).toHaveProperty("disabled", false);
    const approve = button(/Approve draft/)!;
    expect(approve).toHaveProperty("disabled", true);
    // An approval names a stored revision; unsaved text is not any revision.
    expect(approve.getAttribute("title")).toMatch(/Save your changes first/);

    fireEvent.click(button(/Save changes/)!);
    expect(onSave).toHaveBeenCalledWith({
      recipient: "ap@counterparty.example",
      subject: "Invoice 42 — short payment",
      body: "Reworded ask.",
      revision: 2,
    });
  });

  it("pending: an out-of-allowlist recipient blocks both save and approve", () => {
    panel();
    fireEvent.change(recipientInput(), {
      target: { value: "ap@attacker.example" },
    });

    expect(
      screen.getByText(
        /attacker.example is not an allowed counterparty domain/,
      ),
    ).toBeTruthy();
    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pending: sends the displayed revision with a discard", () => {
    panel({ revision: 7 });
    fireEvent.click(button(/Discard draft/)!);
    expect(onDecide).toHaveBeenCalledWith("discard_draft", 7);
  });

  it("approved: shows the armed revision and only offers revoke", () => {
    panel({
      draft_status: "approved",
      revision: 3,
      approved_revision: 3,
      approved_by: "approver@x.com",
      approved_at: "2026-08-09T10:15:00.000Z",
    });

    expect(screen.getByText(/Armed at revision 3/)).toBeTruthy();
    expect(screen.getByText(/approved by approver@x.com/)).toBeTruthy();
    expect(button(/Revoke approval/)).toBeTruthy();
    expect(button(/Save changes/)).toBeNull();
    expect(button(/Approve draft/)).toBeNull();
    expect(button(/Discard draft/)).toBeNull();
    // Read-only: the approved text is what the gateway will compare the send against.
    expect(screen.queryByLabelText("Counterparty email body")).toBeNull();

    fireEvent.click(button(/Revoke approval/)!);
    expect(onDecide).toHaveBeenCalledWith("revoke_draft", 3);
  });

  it("discarded: read-only, with who discarded it and no controls", () => {
    panel({
      draft_status: "discarded",
      discarded_by: "analyst@x.com",
      discarded_at: "2026-08-09T11:00:00.000Z",
    });

    expect(screen.getByText("discarded")).toBeTruthy();
    expect(screen.getByText(/discarded by analyst@x.com/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Counterparty email body")).toBeNull();
  });

  it("sent: read-only, stamped, and no way to send again", () => {
    panel({
      draft_status: "sent",
      revision: 3,
      approved_revision: 3,
      send_attempted_at: "2026-08-09T12:00:00.000Z",
      sent_at: "2026-08-09T12:00:03.000Z",
    });

    expect(screen.getByText("sent")).toBeTruthy();
    expect(screen.getByText(/sent 2026-08-09 12:00Z/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // `send_attempted_at` is set here too, but the send is confirmed — no warning, no override.
    expect(screen.queryByText(/Send state unknown/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("EmailDraftPanel — unknown send state", () => {
  const unknown = {
    draft_status: "approved" as const,
    revision: 3,
    approved_revision: 3,
    send_attempted_at: "2026-08-09T12:00:00.000Z",
    sent_at: null,
  };

  it("warns and gates the retry behind an explicit human statement", () => {
    panel(unknown);

    expect(screen.getByText(/Send state unknown/)).toBeTruthy();
    expect(screen.getByText(/2026-08-09 12:00Z/)).toBeTruthy();
    // Points the analyst at the one place that can actually answer the question.
    expect(screen.getByText(/Sent Items before retrying/)).toBeTruthy();

    const box = screen.getByRole("checkbox");
    expect(box).toHaveProperty("checked", false);
    fireEvent.click(box);
    expect(onOverrideChange).toHaveBeenCalledWith(true);
  });

  it("reflects the override the page is holding", () => {
    panel(unknown, { overrideUnknownSend: true });
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  });

  it("omits the override when the page offers no handler for it", () => {
    panel(unknown, { onOverrideChange: undefined });
    expect(screen.getByText(/Send state unknown/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("EmailDraftPanel — case status and busy", () => {
  it("locks a live draft once the case is no longer PROPOSED", () => {
    panel({ draft_status: "pending" }, { caseStatus: "RESOLVED" });

    expect(screen.getByText(/The case is RESOLVED/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Counterparty email body")).toBeNull();
  });

  it("disables every control while another action is in flight", () => {
    panel({}, { busy: true });

    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
    expect(button(/Discard draft/)).toHaveProperty("disabled", true);
    expect(recipientInput()).toHaveProperty("disabled", true);
  });

  it("explains the missing address rather than inventing one from the hint", () => {
    panel({ recipient: null, recipient_hint: "Counterparty AP" });

    expect(recipientInput()).toHaveProperty("value", "");
    expect(
      screen.getByText(/believes this goes to Counterparty AP/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Allowed domains: counterparty.example/),
    ).toBeTruthy();
    // Nothing to save and nothing to approve until a human supplies the address.
    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
  });

  it("says so when the deployment allows no counterparty domain at all", () => {
    panel({}, { allowedDomains: [] });

    // Said twice, deliberately: once as the field's hint, once inline against the address that is
    // already sitting in the input and can no longer be used.
    expect(
      screen.getByText(
        /No counterparty domains are configured for this deployment/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/no address can be used yet/)).toBeTruthy();
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
  });
});
