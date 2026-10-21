import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { resolveAppAccess, type Viewer } from "@/lib/auth/apps";
import {
  effectiveEnv,
  getPreferences,
  isConsoleAdmin,
  isConsoleConfigured,
  organizationLabel,
} from "@/lib/console/settings";
import type { UserPreferences, ViewerConsoleFields } from "@/lib/console/types";

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
//
// Per-app access is resolved against the OVERLAID environment (`lib/console/settings.ts`): the
// process environment with the console's stored access groups on top, the same view the proxy and
// the admin helpers use, so the rail never shows an app the proxy would 403. The `console` block and
// `preferences` are the shell's own additions (`ViewerConsoleFields`).
export const runtime = "nodejs";

/** The full body: the registry's `Viewer` plus the console layer's fields. */
export type MeResponse = Viewer & ViewerConsoleFields;

/**
 * The caller's stored preferences, or `{}` when they cannot be read.
 *
 * A Parameter Store failure here must not fail the whole route: the rail can render without
 * preferences, and it cannot render without the viewer.
 */
async function preferencesOrEmpty(subject: string): Promise<UserPreferences> {
  try {
    return await getPreferences(subject);
  } catch (err) {
    console.warn(`[api/me] could not read preferences: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * Report the calling viewer's identity, per-app access and console-level fields.
 *
 * Verifies the token here as well as in the proxy (defense in depth, like every other route): a
 * matcher change that dropped `/api/me` must not turn this into an unauthenticated group oracle.
 *
 * @param req - the incoming request; its bearer token is verified.
 * @returns 200 with `Viewer & ViewerConsoleFields`, or the 401/503 from token verification.
 */
export async function GET(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }
  const env = await effectiveEnv();
  const viewer: MeResponse = {
    subject: auth.subject,
    groups: auth.groups,
    mode: auth.mode,
    apps: resolveAppAccess(auth.groups, env),
    console: {
      // Environment-only: the overlay never carries CONSOLE_ADMIN_GROUP, so the default env is right.
      admin: isConsoleAdmin(auth.groups),
      configured: isConsoleConfigured(),
      organizationLabel: await organizationLabel(),
    },
    preferences: await preferencesOrEmpty(auth.subject),
  };
  // no-store: a group change in the IdP must be visible on the next page load, not after a cache TTL.
  return NextResponse.json(viewer, { headers: { "Cache-Control": "no-store" } });
}
