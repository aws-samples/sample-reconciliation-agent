import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { isPipelineAdmin } from "@/lib/pipelineAdmin";

// Who the browser is talking to the BFF as.
//
// The client cannot answer this itself. It holds an ID token, but nothing in the client should be
// deciding what that token entitles it to — and the `sub` is needed for a mundane reason too: chat
// sessions and column layouts are stored per person, and a guessed key on a shared desk browser
// would merge two people's history.
//
// `isAdmin` here decides only what the UI SHOWS. Every route that changes the pipeline checks the
// group again for itself, so a client that lies to itself about this gets a 403 rather than a write.
export const runtime = "nodejs";

/**
 * Report the calling viewer's identity and whether they may administer the pipeline.
 *
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
    isAdmin: isPipelineAdmin(auth.groups),
    mode: auth.mode,
  });
}
