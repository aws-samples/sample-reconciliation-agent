import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-auth";
import { ContactUnavailable, resolveContactAddress } from "@/lib/contactStore";
import { DraftConflict, editDraft } from "@/lib/emailDraftStore";

// Same-origin BFF: edit the counterparty email draft on one case.
//
// This route exists because the model never picks the recipient — items being reconciled arrive from
// documents an outside party wrote, so an address the model proposed is attacker-influenceable. The
// analyst picks a recipient from the operator's own contact list, and the row stores the CONTACT ID,
// never an address: the address is resolved server-side at send time, which is what makes
// deactivating a contact revoke an already-approved draft.
//
// Every edit bumps `revision` and returns the draft to `pending`, which revokes any approval. The
// send is authorized by the gateway interceptor against this stored text at this revision, so the
// only message that can leave is one an analyst read and approved.
export const runtime = "nodejs";

/**
 * Replace the draft's recipient contact, subject and body.
 *
 * Body: `{recipient_contact_id, subject, body, revision}` — `revision` is the one the analyst was
 * looking at, and the write fails with 409 if it is no longer current.
 *
 * @param req - the request; its Authorization header identifies who is editing.
 * @param params - route params carrying the case id.
 * @returns 200 with the updated draft, 400 on an unusable field or an unsendable contact, 401/503
 *   when unauthenticated, 409 when the draft moved underneath the caller, 502 on any other write
 *   failure.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // `src/proxy.ts` already authorized everything under /api/recon/, but it does not pass the
  // verified subject down to handlers. Re-verifying is how this route learns WHO is editing —
  // `edited_by` is the record of which human wrote text that may go to an outside party, so it
  // cannot come from the request body. It also means the route is not the thing that opens if the
  // middleware's matcher is ever narrowed.
  const auth = await authorizeRequest(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.message }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as {
    recipient_contact_id?: string;
    subject?: string;
    body?: string;
    revision?: number;
  };

  const contactId = (body.recipient_contact_id ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const draftBody = (body.body ?? "").trim();
  const revision = Number(body.revision);

  // The revision must be supplied. Defaulting it to 0 would make a client that forgot to send it
  // silently overwrite whatever revision happens to be current — the exact race this pins.
  if (!Number.isInteger(revision) || revision < 0)
    return NextResponse.json(
      { error: "revision is required and must be a non-negative integer" },
      { status: 400 },
    );
  if (!subject || !draftBody)
    return NextResponse.json(
      { error: "subject and body are both required" },
      { status: 400 },
    );
  if (!contactId)
    return NextResponse.json(
      { error: "recipient_contact_id is required" },
      { status: 400 },
    );

  // Resolved only to VALIDATE, and the address is then thrown away rather than stored. Doing it here
  // buys the analyst a 400 while they are still looking at the form, instead of a gateway denial
  // after they have approved a draft that was never sendable.
  let resolved: string;
  try {
    resolved = await resolveContactAddress({
      contactId,
      kind: "counterparty",
    });
  } catch (err) {
    if (err instanceof ContactUnavailable)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }

  // The address is resolved here ONLY to prove the contact still resolves to one -- a deactivated or
  // deleted contact must fail now rather than at send time. It is deliberately not domain-checked.
  //
  // `counterparty_email_domains` is a GATE, and the gate lives at the gateway interceptor, which
  // re-derives the verdict from its own copy on every send. Checking it a second time here bought
  // nothing: the interceptor is the boundary either way, and a second opinion in the BFF could only
  // ever be the same answer or a WRONG one, because the two read different copies of the variable
  // and the BFF's is a container env var fixed at task start.
  void resolved;

  try {
    const draft = await editDraft({
      id,
      recipientContactId: contactId,
      subject,
      body: draftBody,
      revision,
      editedBy: auth.subject,
    });
    return NextResponse.json({ proposed_email: draft });
  } catch (err) {
    if (err instanceof DraftConflict)
      return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}
