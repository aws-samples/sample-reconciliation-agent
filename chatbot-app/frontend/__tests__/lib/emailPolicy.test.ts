/**
 * The address SHAPE and contact-selection checks the UI performs.
 *
 * There is deliberately nothing here about the domain allowlist: `counterparty_email_domains` is a
 * gate, and the gateway request interceptor is the only thing that reads it. These functions
 * authorize nothing either -- what they protect is honesty. A shape check that accepts a string
 * nobody can receive, or a selection check that stays silent on a deactivated contact, sends an
 * analyst into a denial with no explanation.
 *
 * The refusal MESSAGES are asserted, not just the null/non-null split. The message is the entire
 * product of these functions: "not null" tells an analyst nothing.
 */
import { describe, it, expect } from "vitest";
import {
  addressDomain,
  contactSelectionRejectionReason,
  storableAddressReason,
  type ContactChoice,
} from "@/lib/emailPolicy";

function contact(over: Partial<ContactChoice> = {}): ContactChoice {
  return {
    contact_id: "cp-ap",
    display_name: "Counterparty AP",
    kind: "counterparty",
    active: true,
    ...over,
  };
}

describe("addressDomain", () => {
  it("returns the lowercased domain of a bare address", () => {
    expect(addressDomain(" AP@Counterparty.Example ")).toBe(
      "counterparty.example",
    );
  });

  it("has no opinion about allowlists", () => {
    // Shape must be answerable without a policy: storing a contact and being permitted to email one
    // are different questions, and only the send gate answers the second.
    expect(addressDomain("someone@evil.com")).toBe("evil.com");
  });

  it("rejects framed, quoted, multi-part and undotted forms", () => {
    for (const bad of [
      "",
      "   ",
      "AP <ap@counterparty.example>",
      '"ap"@counterparty.example',
      "a@b.example, c@d.example",
      "ap@localhost",
      "@counterparty.example",
      "ap@",
      "apcounterparty.example",
      "a@b@c.example",
    ])
      expect(addressDomain(bad)).toBe(null);
  });
});

describe("storableAddressReason", () => {
  it("distinguishes a blank field from a malformed one", () => {
    // Two different operator mistakes deserve two different sentences: one is an unfilled field, the
    // other is a string that will never reach anybody.
    expect(storableAddressReason("  ")).toBe("email is required");
    expect(storableAddressReason("AP <ap@counterparty.example>")).toBe(
      "AP <ap@counterparty.example> is not a single plain email address (expected one address of the form name@example.com, with no display name, quotes or angle brackets)",
    );
  });

  it("accepts any well-formed address regardless of domain", () => {
    // The admin owns the contact list. This check is the ONLY address refusal the contact routes make,
    // and it must not smuggle a domain opinion in with the shape one.
    expect(storableAddressReason("ap@some-outside-desk.example")).toBe(null);
    expect(storableAddressReason("ap@evil.com")).toBe(null);
  });
});

describe("contactSelectionRejectionReason", () => {
  const contacts = [contact()];

  it("asks for a choice when nothing is picked", () => {
    expect(
      contactSelectionRejectionReason({
        contactId: "",
        contacts,
        kind: "counterparty",
      }),
    ).toBe("Choose who this email goes to.");
  });

  it("says a stale id may have been removed", () => {
    // The list is loaded and active-only, so an id missing from it is most often a contact an operator
    // deactivated between the page load and the click.
    expect(
      contactSelectionRejectionReason({
        contactId: "cp-gone",
        contacts,
        kind: "counterparty",
      }),
    ).toBe(
      "No contact answers to cp-gone. It may have been removed — pick another.",
    );
  });

  it("refuses a deactivated contact", () => {
    expect(
      contactSelectionRejectionReason({
        contactId: "cp-ap",
        contacts: [contact({ active: false })],
        kind: "counterparty",
      }),
    ).toBe("Counterparty AP is deactivated and cannot be sent to.");
  });

  it("refuses a contact of the wrong kind, naming both kinds", () => {
    // An internal notification contact is a real, active, sendable contact — just not for this send.
    // Mirrors `resolve_address`, which refuses the same pairing server-side.
    expect(
      contactSelectionRejectionReason({
        contactId: "cp-ap",
        contacts: [contact({ kind: "internal_notification" })],
        kind: "counterparty",
      }),
    ).toBe(
      "Counterparty AP is a internal_notification contact, which cannot receive a counterparty email.",
    );
  });

  it("agrees with the server on a valid selection", () => {
    // The one positive case, and the one that matters most: the four refusals in `resolve_address` are
    // unknown id, inactive, wrong kind, and no address stored. This selection trips none of the first
    // three, and the fourth is unobservable from here by design — the picker never receives an address.
    // So `null` here must mean the Python would resolve it.
    expect(
      contactSelectionRejectionReason({
        contactId: "cp-ap",
        contacts,
        kind: "counterparty",
      }),
    ).toBe(null);
  });
});
