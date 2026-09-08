import { NextResponse } from "next/server";
import { requireReconAdmin } from "@/lib/reconAdmin";
import {
  CONTACT_KINDS,
  ContactValidationError,
  getContactRow,
  listContacts,
  putContact,
  type ContactKind,
} from "@/lib/contactStore";
import { storableAddressReason } from "@/lib/emailPolicy";
import { randomUUID } from "node:crypto";

// Same-origin BFF for the operator's recipient list — the ONLY write path onto `recon-contacts` in
// the deployment. The agent's gateway tool reads a projection with no `email` in it and there is no
// write tool at all, so "who may this system email" is answered here and nowhere else.
//
// Validation lives in this route rather than in the form because the route is the boundary: a form is
// a convenience for the person filling it in, and anything that can be skipped is not a check. Every
// refusal answers 400 with a message naming the specific problem.
//
// What this route refuses is narrow on purpose: a missing name, an unknown kind, a string that is not
// an address, a colliding id. The DOMAIN of a counterparty address is reported and not refused — the
// admin owns the contact list, the deploy-time allowlist owns egress, and the interceptor enforces it
// on every send, and is consulted nowhere else. See the module comment in `lib/emailPolicy.ts`.
export const runtime = "nodejs";

export async function GET(req: Request) {
  // The read is gated as tightly as the write, and for a sharper reason: this is the one endpoint that
  // returns the addresses themselves. Analysts get the projected list from `/api/recon/contacts`.
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;
  try {
    // Deactivated rows included, addresses included. This audience owns the list.
    return NextResponse.json({ contacts: await listContacts() });
  } catch (err) {
    return NextResponse.json(
      { error: `contact list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;

  const body = (await req.json().catch(() => ({}))) as {
    contact_id?: string;
    display_name?: string;
    email?: string;
    kind?: string;
  };
  const displayName = (body.display_name ?? "").trim();
  const email = (body.email ?? "").trim();
  const kind = (body.kind ?? "").trim();
  if (!displayName)
    return NextResponse.json(
      { error: "display_name is required" },
      { status: 400 },
    );
  // Shape only. Refused because a malformed string reaches nobody however the deployment is
  // configured, so storing one just plants a contact that fails at send with a worse message.
  const malformed = storableAddressReason(email);
  if (malformed)
    return NextResponse.json({ error: malformed }, { status: 400 });
  if (!(CONTACT_KINDS as readonly string[]).includes(kind))
    return NextResponse.json(
      { error: `kind must be one of ${CONTACT_KINDS.join(", ")}` },
      { status: 400 },
    );

  // The domain allowlist is REPORTED here, never enforced here.
  //
  // Owning the contact list and owning the egress policy are different jobs. The allowlist is fixed at
  // deploy time (terraform `counterparty_email_domains`), so refusing an out-of-domain address here
  // would leave the admin unable to record one they legitimately need on file — a desk that will be
  // allowed next week, a party they only ever receive from.
  //
  // Reporting instead of refusing loosens nothing. The gateway request interceptor re-derives the
  // verdict from its own allowlist on every send, resolves the address from this table rather than from
  // the caller, and fails closed on an empty allowlist. An out-of-domain contact is therefore storable
  // and simply unsendable. That is reported by nothing here on purpose: the allowlist is a GATE, and
  // this route is not the gate.
  // An operator-supplied id is honoured so a deployment can be seeded with stable ids, but POST means
  // CREATE: colliding with an existing row would silently overwrite a recipient, so it is a 409 and
  // the caller is pointed at PUT.
  const contactId = (body.contact_id ?? "").trim() || `contact-${randomUUID()}`;
  try {
    if (await getContactRow(contactId))
      return NextResponse.json(
        {
          error: `contact ${contactId} already exists; use PUT to change it`,
        },
        { status: 409 },
      );
    const contact = await putContact({
      contact: {
        contact_id: contactId,
        display_name: displayName,
        email,
        kind: kind as ContactKind,
        active: true,
      },
      actor: who.actor,
    });
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    if (err instanceof ContactValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
