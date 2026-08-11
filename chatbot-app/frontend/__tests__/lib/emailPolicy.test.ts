import { describe, it, expect } from "vitest";
import {
  parseDomainAllowlist,
  isRecipientAllowed,
  recipientRejectionReason,
} from "@/lib/emailPolicy";

// This module is the UX mirror, not the gate (the gateway interceptor is). These tests still cover
// the adversarial cases, because the value of the mirror is that an analyst never gets a late,
// opaque gateway denial for something the form could have told them immediately.
describe("emailPolicy", () => {
  it("normalizes the allowlist and drops empty entries", () => {
    expect(parseDomainAllowlist(" example.com , Partner.CO.UK ,, ")).toEqual([
      "example.com",
      "partner.co.uk",
    ]);
    expect(parseDomainAllowlist("")).toEqual([]);
    expect(parseDomainAllowlist("   ")).toEqual([]);
  });

  it("matches the domain exactly, so a lookalike suffix does not pass", () => {
    // The whole attack this guard exists to stop: a suffix match would let notevil.com through.
    const allow = ["evil.com"];
    expect(isRecipientAllowed("a@evil.com", allow)).toBe(true);
    expect(isRecipientAllowed("a@notevil.com", allow)).toBe(false);
    expect(isRecipientAllowed("a@evil.com.attacker.io", allow)).toBe(false);
    expect(isRecipientAllowed("a@sub.evil.com", allow)).toBe(false);
  });

  it("is case-insensitive on both the address and the allowlist", () => {
    expect(isRecipientAllowed("A.B@Example.COM", ["example.com"])).toBe(true);
    expect(
      isRecipientAllowed("a@example.com", parseDomainAllowlist("EXAMPLE.com")),
    ).toBe(true);
  });

  it("allows nothing when the allowlist is empty", () => {
    // A misconfigured control closes the door — the opposite of a fail-safe-to-permissive default.
    expect(isRecipientAllowed("a@example.com", [])).toBe(false);
  });

  it("rejects malformed and decorated addresses instead of unwrapping them", () => {
    const allow = ["example.com"];
    expect(isRecipientAllowed("Foo <a@example.com>", allow)).toBe(false);
    expect(isRecipientAllowed("a@b@example.com", allow)).toBe(false);
    expect(isRecipientAllowed("noatsign", allow)).toBe(false);
    expect(isRecipientAllowed("@example.com", allow)).toBe(false);
    expect(isRecipientAllowed("a@", allow)).toBe(false);
    expect(isRecipientAllowed("a@localhost", allow)).toBe(false);
    expect(isRecipientAllowed("a@example.com, b@example.com", allow)).toBe(
      false,
    );
    // Surrounding whitespace is trimmed; interior whitespace is not tolerated.
    expect(isRecipientAllowed("  a@example.com  ", allow)).toBe(true);
    expect(isRecipientAllowed("a @example.com", allow)).toBe(false);
  });

  it("explains the rejection without erroring on an empty field", () => {
    const allow = ["example.com"];
    expect(recipientRejectionReason("", allow)).toContain("Enter");
    expect(recipientRejectionReason("a@example.com", allow)).toBeNull();
    expect(recipientRejectionReason("a@evil.com", allow)).toContain("evil.com");
    expect(recipientRejectionReason("a@evil.com", allow)).toContain(
      "example.com",
    );
    expect(recipientRejectionReason("nonsense", allow)).toContain(
      "single plain address",
    );
    expect(recipientRejectionReason("a@example.com", [])).toContain(
      "No counterparty domains are configured",
    );
  });
});
