import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { resolveAppAccess, type Viewer } from "@/lib/auth/apps";

// Who the browser is talking to the shell as, and which apps it may show them.
//
// The client cannot answer this itself. It holds an ID token, but nothing in the client should be
// deciding what that token entitles it to. The shell needs the answer before it renders anything:
// the app rail lists only the apps the viewer may use, the landing page sends a single-app viewer
// straight there, and a viewer with no apps at all gets an explanation instead of a blank rail.
//
// This route is the one BFF path the proxy admits on authentication alone (see `lib/auth/access.ts`).
// That is deliberate: a caller who may use no app still needs to be told so, and this is where.
//
// Everything in the body decides only what the UI SHOWS. The proxy re-checks access (and enablement)
// on every app-prefixed call, and the admin-gated write routes re-check their admin group for
// themselves, so a client that lies to itself about this gets a 403 rather than data or a write. Note
// the qualifier: recon's system-prompt, skills, harness and case writes are access-gated only, which
// is why the access group (and `REQUIRE_ACCESS_GROUPS` on a composed console) is a real boundary.
export const runtime = "nodejs";

/**
 * Report the calling viewer's identity and per-app access.
 *
 * Verifies the token here as well as in the proxy (defense in depth, like every other route): a
 * matcher change that dropped `/api/me` must not turn this into an unauthenticated group oracle.
 *
 * @param req - the incoming request; its bearer token is verified.
 * @returns 200 with the `Viewer` shape from `lib/auth/apps.ts`, or the 401/503 from token
 *   verification.
 */
export async function GET(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }
  const viewer: Viewer = {
    subject: auth.subject,
    groups: auth.groups,
    mode: auth.mode,
    apps: resolveAppAccess(auth.groups),
  };
  // no-store: a group change in the IdP must be visible on the next page load, not after a cache TTL.
  return NextResponse.json(viewer, { headers: { "Cache-Control": "no-store" } });
}
