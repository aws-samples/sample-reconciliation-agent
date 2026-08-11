import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-auth";
import {
  parseDomainAllowlist,
  recipientRejectionReason,
} from "@/lib/emailPolicy";
import { DraftConflict, editDraft } from "@/lib/emailDraftStore";

// Same-origin BFF: edit the counterparty email draft on one case.
//
// This route exists because the model never picks the recipient — items being reconciled arrive from
// documents an outside party wrote, so an address the model proposed is attacker-influenceable. The
// analyst supplies it here, and what they write is checked against the operator's domain allowlist
// before it is stored.
//
// Every edit bumps `revision` and returns the draft to `pending`, which revokes any approval. The
// send is authorized by the gateway interceptor against this stored text at this revision, so the
// only message that can leave is one an analyst read and approved.
export const runtime = "nodejs";

const ALLOWED_DOMAINS = () =>
  parseDomainAllowlist(process.env.COUNTERPARTY_EMAIL_DOMAINS ?? "");

/**
 * Replace the draft's recipient, subject and body.
 *
 * Body: `{recipient, subject, body, revision}` — `revision` is the one the analyst was looking at,
 * and the write fails with 409 if it is no longer current.
 *
 * @param req - the request; its Authorization header identifies who is editing.
 * @param params - route params carrying the case id.
 * @returns 200 with the updated draft, 400 on an unusable field, 401/503 when unauthenticated,
 *   409 when the draft moved underneath the caller, 502 on any other write failure.
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
    recipient?: string;
    subject?: string;
    body?: string;
    revision?: number;
  };

  const recipient = (body.recipient ?? "").trim();
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

  // Server-side allowlist check. The panel checks the same thing while the analyst types, but that
  // is a courtesy: this is the write that persists the address, and the interceptor will refuse the
  // send anyway, so an address rejected here saves the analyst a confusing denial much later.
  const rejection = recipientRejectionReason(recipient, ALLOWED_DOMAINS());
  if (rejection)
    return NextResponse.json({ error: rejection }, { status: 400 });

  try {
    const draft = await editDraft({
      id,
      recipient,
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
