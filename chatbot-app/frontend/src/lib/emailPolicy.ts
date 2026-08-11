/**
 * Counterparty recipient address check — a UX MIRROR, **not** the security control.
 *
 * The authority is `backend/recon_core/email_policy.py`, which the gateway request interceptor
 * imports and which sits on the send path and fails closed. This copy exists so the draft panel can
 * tell an analyst "that domain is not allowed" while they type, and so the BFF's draft `PUT` can
 * answer with a clean 400 instead of letting the address travel all the way to a gateway denial at
 * send time.
 *
 * The distinction matters for how a divergence between the two is triaged: because the interceptor
 * re-derives the verdict from its own allowlist on every send, drift here is a UX bug (a form that
 * accepts something the send will refuse, or nags about something it would allow) and never a
 * bypass. Nothing is authorized by this file. Do not add a caller that treats it as a gate.
 *
 * Deliberately no shared fixture and no cross-language parity test: a fixture pins agreement only on
 * the cases someone already thought of, and maintaining one implies the two copies are equally
 * trusted. One authority is the cheaper correctness story.
 */

/**
 * Parse the comma-separated allowlist into normalized domains.
 *
 * @param raw - e.g. `"example.com, Partner.CO.UK"`. Empty or whitespace-only yields `[]`, which
 *   allows NOTHING — see {@link isRecipientAllowed}.
 * @returns lowercased, trimmed domains with empty entries dropped.
 */
export function parseDomainAllowlist(raw: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Whether `address` is a bare address in one of the allowlisted domains.
 *
 * Mirrors the Python authority's rules, including the two that are easy to get wrong:
 *  - the domain match is EXACT, not a suffix match, so `notevil.com` does not satisfy `evil.com`;
 *  - an empty allowlist allows nothing, because a misconfigured control must close the door.
 *
 * The decorated form `Foo <a@b.com>` is rejected rather than unwrapped: the interceptor compares the
 * raw address it finds in the Graph payload, so accepting a decorated form here would put the two
 * layers into disagreement about what the recipient is.
 *
 * @param address - the candidate recipient address.
 * @param allowlist - normalized domains from {@link parseDomainAllowlist}.
 * @returns true only when the address is well-formed and its domain is allowlisted.
 */
export function isRecipientAllowed(
  address: string,
  allowlist: string[],
): boolean {
  if (allowlist.length === 0) return false;
  const candidate = (address ?? "").trim().toLowerCase();
  if (!candidate) return false;
  // Reject framing/whitespace/quoting outright rather than trying to unwrap it.
  if (/[ \t\r\n<>,;"']/.test(candidate)) return false;
  const parts = candidate.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain || !domain.includes(".")) return false;
  return allowlist.includes(domain);
}

/**
 * A short reason the address is unusable, or `null` when it is fine — for inline form feedback.
 *
 * Split from the boolean so the panel can say WHY without re-deriving it, and so the empty-input
 * case reads as "nothing typed yet" rather than as an error the moment the field renders.
 *
 * @param address - what the analyst has typed so far.
 * @param allowlist - normalized domains from {@link parseDomainAllowlist}.
 * @returns a human-readable reason, or null when the address is allowed.
 */
export function recipientRejectionReason(
  address: string,
  allowlist: string[],
): string | null {
  const candidate = (address ?? "").trim();
  if (!candidate) return "Enter the counterparty's email address.";
  if (allowlist.length === 0)
    return "No counterparty domains are configured, so no address can be used yet.";
  if (isRecipientAllowed(candidate, allowlist)) return null;
  const domain = candidate.toLowerCase().split("@")[1];
  if (!domain || !candidate.includes("@") || candidate.split("@").length !== 2)
    return "Enter a single plain address, e.g. name@example.com.";
  return `${domain} is not an allowed counterparty domain (allowed: ${allowlist.join(", ")}).`;
}
