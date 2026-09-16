/**
 * Counterparty recipient checks the UI performs — address SHAPE and contact selection.
 *
 * ⚠️ There is deliberately no domain-allowlist logic in this file, and none anywhere else in the
 * frontend. `counterparty_email_domains` is a GATE: it is read by the gateway request interceptor
 * (`backend/recon_core/email_policy.py`), which sits on the send path, fails closed, and re-derives
 * the verdict from its own copy on every send. That is the only place it is consulted.
 *
 * Do NOT mirror it here for "early feedback". A mirror is a net loss three ways:
 *
 *  - The BFF reads a container env var fixed at task start, so a narrowed allowlist is enforced by
 *    the interceptor while the UI still shows the wider one -- a control that misreports its own
 *    configuration.
 *  - Saving an out-of-domain contact would return a 201 WITH an amber advisory, which reads as "the
 *    save was blocked" when the row has in fact been written. Contact-list membership and send
 *    permission are different questions, and answering the second on the screen that asks the first
 *    tells the operator their edit failed.
 *  - Refusing out-of-domain addresses on the draft `PUT` as well puts the same rule in three places,
 *    where it can only ever agree with the interceptor or be wrong.
 *
 * If an analyst needs to know whether an address is sendable, the answer has to come from the thing
 * that decides.
 *
 * {@link storableAddressReason} stays and the contact routes do refuse on it, because it authorizes
 * nothing: rejecting `"Foo <a@b>"` or `"not an address"` is a shape check, and a malformed string
 * reaches nobody whatever any allowlist says.
 */

/**
 * The lowercased domain of a bare address, or null when the string is not one.
 *
 * The shape rules of {@link isRecipientAllowed}, minus the allowlist, so the two cannot disagree
 * about what counts as an address. Split out because storing a contact and being allowed to email
 * one are different questions: the contact table accepts any address in any domain, and the domain
 * verdict belongs to the send path.
 *
 * @param address - the candidate address.
 * @returns the domain part, lowercased, or null when `address` is empty, framed (`Foo <a@b>`),
 *   quoted, multi-part, or has no dotted domain.
 */
export function addressDomain(address: string): string | null {
  const candidate = (address ?? "").trim().toLowerCase();
  if (!candidate) return null;
  // Reject framing/whitespace/quoting outright rather than trying to unwrap it.
  if (/[ \t\r\n<>,;"']/.test(candidate)) return null;
  const parts = candidate.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain || !domain.includes(".")) return null;
  return domain;
}

/**
 * Why `address` is not a storable address, or null when it is one.
 *
 * Shape only — nothing about domains, kinds or allowlists. This is the one address check the contact
 * routes still REFUSE on, because a string that is not an address cannot be corrected later by
 * widening an allowlist: it will simply never reach anybody.
 *
 * @param address - the operator's input.
 * @returns a human-readable reason, or null when the address is well-formed.
 */
export function storableAddressReason(address: string): string | null {
  const candidate = (address ?? "").trim();
  if (!candidate) return "email is required";
  if (addressDomain(candidate) === null)
    return `${candidate} is not a single plain email address (expected one address of the form name@example.com, with no display name, quotes or angle brackets)`;
  return null;
}

/**
 * The fields a contact picker needs, and deliberately not one more.
 *
 * No `email`. The picker never sees an address: the analyst confirms WHO, and the id they pick is
 * resolved server-side at send time. Typed structurally rather than importing `Contact` from
 * `lib/contactStore` so this file stays free of the DynamoDB client and usable in a client component.
 */
export interface ContactChoice {
  contact_id: string;
  display_name: string;
  kind: string;
  active: boolean;
}

/**
 * A short reason the picked CONTACT cannot receive this send, or `null` when it can.
 *
 * The three refusals mirror `resolve_address` in `backend/contacts/store.py` — unknown id,
 * deactivated, wrong kind — with the same caveat as everything else in this file: it is inline form
 * feedback, and the server decides. It exists because the draft form picks a CONTACT rather than
 * taking a typed address, so {@link recipientRejectionReason} has nothing to say about the selection
 * and the form would otherwise give the analyst no feedback at all.
 *
 * The fourth refusal `resolve_address` raises on — a contact with no address stored — has no mirror
 * here on purpose: this side never receives the address, so it cannot tell a blank one from a withheld
 * one, and guessing would mean nagging about a contact that sends perfectly well.
 *
 * @param contactId - the id the analyst picked; empty means nothing picked yet.
 * @param contacts - the choices the picker was populated from.
 * @param kind - what this send is for, e.g. `"counterparty"`.
 * @returns a human-readable reason, or null when the selection is usable.
 */
export function contactSelectionRejectionReason({
  contactId,
  contacts,
  kind,
}: {
  contactId: string;
  contacts: readonly ContactChoice[];
  kind: string;
}): string | null {
  const picked = (contactId ?? "").trim();
  if (!picked) return "Choose who this email goes to.";
  const contact = contacts.find((c) => c.contact_id === picked);
  // Unknown rather than absent: the list is loaded, so an id not in it is a stale selection — most
  // often a contact an operator deactivated and removed from the analyst's active-only list.
  if (!contact)
    return `No contact answers to ${picked}. It may have been removed — pick another.`;
  if (!contact.active)
    return `${contact.display_name} is deactivated and cannot be sent to.`;
  if (contact.kind !== kind)
    return `${contact.display_name} is a ${contact.kind} contact, which cannot receive a ${kind} email.`;
  return null;
}
