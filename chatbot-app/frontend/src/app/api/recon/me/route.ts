import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-auth";
import { isReconAdmin } from "@/lib/reconAdmin";

// Who the browser is talking to the BFF as.
//
// The client cannot answer this itself. It holds an ID token, but nothing in the client should be
// deciding what that token entitles it to — and the `sub` is needed for a mundane reason too: column
// layouts are stored per person, and on a shared trading-floor browser a guessed key silently merges two
// people's layouts (see `columnPrefs.ts`).
//
// `isAdmin` here decides only what the UI SHOWS. Every route that changes configuration checks the group
// again for itself, so a client that lies to itself about this gets a 403 rather than a config write.
export const runtime = "nodejs";

/**
 * Report the calling viewer's identity and whether they may administer configuration.
 *
 * @param req - the incoming request; its bearer token is verified.
 * @returns 200 with `{subject, groups, isAdmin, mode}`, or the 401/503 from token verification.
 */
export async function GET(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }
  return NextResponse.json({
    subject: auth.subject,
    groups: auth.groups,
    isAdmin: isReconAdmin(auth.groups),
    mode: auth.mode,
  });
}
