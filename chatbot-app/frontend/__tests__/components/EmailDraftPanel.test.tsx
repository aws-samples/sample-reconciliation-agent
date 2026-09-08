/**
 * Render tests for the counterparty email draft panel.
 *
 * The panel is the only place a human decides what leaves the operator, so what these tests pin
 * down is which controls a given `draft_status` offers — and, more to the point, which it withholds.
 * An "Approve draft" button that is live while the textarea holds unsaved text would approve a
 * revision that does not exist; a plain retry offered after an unconfirmed send would offer to
 * double-send; an approve button on a draft that failed to render would arm text nobody wrote. All
 * three are cheap to assert here and expensive to notice in production.
 *
 * Note what the recipient control is: a picker over names, with no address anywhere in the markup.
 * The address is resolved from the chosen id at send time, so several assertions below are about the
 * absence of an address rather than the presence of one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmailDraftPanel } from "@/components/recon/EmailDraftPanel";
import type { EmailDraft } from "@/lib/reconApi";
import type { ContactChoice } from "@/lib/emailPolicy";

const CONTACTS: ContactChoice[] = [
  {
    contact_id: "cp-ap",
    display_name: "Counterparty AP",
    kind: "counterparty",
    active: true,
  },
  {
    contact_id: "cp-ops",
    display_name: "Counterparty Ops Desk",
    kind: "counterparty",
    active: true,
  },
];

function draft(over: Partial<EmailDraft> = {}): EmailDraft {
  return {
    // Always null in every persisted row: the draft stores WHO, not where.
    recipient: null,
    recipient_contact_id: "cp-ap",
    recipient_hint: "Counterparty AP",
    template_id: "tpl-short-payment",
    variables: { reference: "42", amount: "900.00" },
    render_error: null,
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
      contacts={CONTACTS}
      onSave={onSave}
      onDecide={onDecide}
      onOverrideChange={onOverrideChange}
      {...props}
    />,
  );
}

const button = (name: RegExp) => screen.queryByRole("button", { name });
const recipientPicker = () =>
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
    expect(recipientPicker()).toHaveProperty("value", "cp-ap");
    expect(button(/Save changes/)).toBeTruthy();
    expect(button(/Approve draft/)).toBeTruthy();
    expect(button(/Discard draft/)).toBeTruthy();
    // Nothing changed yet, so there is nothing to store.
    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", false);
  });

  it("pending: names the template the wording came from", () => {
    panel();
    // Answers "why does it say that" without the analyst having to ask an operator.
    expect(
      screen.getByText(/Drafted from template tpl-short-payment/),
    ).toBeTruthy();
    expect(screen.getByText(/reference=42, amount=900.00/)).toBeTruthy();
  });

  it("pending: offers names, never addresses", () => {
    // The whole point of the contact indirection. `ContactChoice` has no `email` field, so an address
    // cannot reach this component — but the picker could still invent one out of the hint or the id,
    // and an address on screen is an address that stays reachable after a deactivation.
    //
    // Scoped to the picker rather than the whole panel: `edited by analyst@x.com` is an operator's own
    // identity and belongs in the audit line.
    panel();
    const options = [...recipientPicker().querySelectorAll("option")].map(
      (o) => o.textContent ?? "",
    );
    expect(options).toEqual([
      "— choose a recipient —",
      "Counterparty AP",
      "Counterparty Ops Desk",
    ]);
    for (const label of options) expect(label).not.toMatch(/@/);
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
      recipient_contact_id: "cp-ap",
      subject: "Invoice 42 — short payment",
      body: "Reworded ask.",
      revision: 2,
    });
  });

  it("pending: changing the recipient is itself an edit", () => {
    panel();
    fireEvent.change(recipientPicker(), { target: { value: "cp-ops" } });

    expect(button(/Save changes/)).toHaveProperty("disabled", false);
    fireEvent.click(button(/Save changes/)!);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_contact_id: "cp-ops" }),
    );
  });

  it("pending: no selection blocks save and approve", () => {
    panel({ recipient_contact_id: undefined });

    expect(recipientPicker()).toHaveProperty("value", "");
    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pending: a stale contact id is refused with a reason", () => {
    // What an analyst sees when an operator deactivated the recipient between page load and click.
    panel({ recipient_contact_id: "cp-gone" });

    expect(screen.getByText(/No contact answers to cp-gone/)).toBeTruthy();
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
  });

  it("pending: sends the displayed revision with a discard", () => {
    panel({ revision: 7 });
    fireEvent.click(button(/Discard draft/)!);
    expect(onDecide).toHaveBeenCalledWith("discard_draft", 7);
  });

  it("render_failed: editable and discardable, but never approvable", () => {
    panel({
      draft_status: "render_failed",
      render_error:
        "template tpl-short-payment is missing value for value_date",
    });

    expect(
      screen.getByText(/could not be rendered from its template/),
    ).toBeTruthy();
    expect(screen.getByText(/missing value for value_date/)).toBeTruthy();
    // Fixing it is the only way forward, so the fields stay open and discard stays available…
    expect(bodyInput()).toBeTruthy();
    expect(button(/Save changes/)).toBeTruthy();
    expect(button(/Discard draft/)).toBeTruthy();
    // …but the text on screen is not what would be sent, so there is nothing here to approve. Absent
    // rather than disabled: an analyst cannot make it approvable by trying harder.
    expect(button(/Approve draft/)).toBeNull();
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
    // The recipient reads back as a NAME, resolved from the stored id.
    expect(screen.getByText("Counterparty AP")).toBeTruthy();

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
    expect(recipientPicker()).toHaveProperty("disabled", true);
  });

  it("surfaces the agent's guess without acting on it", () => {
    panel({
      recipient_contact_id: undefined,
      recipient_hint: "Counterparty AP",
    });

    expect(recipientPicker()).toHaveProperty("value", "");
    expect(
      screen.getByText(/believes this goes to Counterparty AP/),
    ).toBeTruthy();
    // Nothing to save and nothing to approve until a human picks someone.
    expect(button(/Save changes/)).toHaveProperty("disabled", true);
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
  });

  it("flags a recipient that disagrees with the source document", () => {
    // Not an error — the hint comes from a counterparty's own paperwork — but a silent mismatch is how
    // mail reaches the wrong desk.
    panel({
      recipient_contact_id: "cp-ops",
      recipient_hint: "Counterparty AP",
    });

    expect(
      screen.getByText(/The source document named Counterparty AP/),
    ).toBeTruthy();
    // Still approvable: the analyst may well be right.
    expect(button(/Approve draft/)).toHaveProperty("disabled", false);
  });

  it("says so when no counterparty contact exists at all", () => {
    panel({}, { contacts: [] });

    expect(
      screen.getByText(/No counterparty contacts are configured/),
    ).toBeTruthy();
    expect(
      screen.getByText(/An operator adds them on the Config tab/),
    ).toBeTruthy();
    expect(button(/Approve draft/)).toHaveProperty("disabled", true);
  });
});
