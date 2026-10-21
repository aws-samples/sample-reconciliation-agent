/**
 * The console-admin gate for `/api/console/settings` and `/api/console/access-check`.
 *
 * Same shape as `requireAppAdmin` (`lib/auth/app-admin.ts`) so a route reads the same way whichever
 * layer it belongs to: verify the token here (defense in depth; the proxy already did, but a matcher
 * change must not turn the settings PUT into an anonymous write), then check the group.
 *
 * The group is `CONSOLE_ADMIN_GROUP` from the ENVIRONMENT. Not the overlay: this is the group that
 * decides who may edit the overlay, so letting the overlay supply it would let one admin's edit make
 * the next admin. The 403 names the variable in both branches (group configured but the caller is not
 * a member; group not configured at all) because in either case the fix is an operator action on the
 * deployment or the identity provider, not something the caller can do from the UI.
 */

import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { CONSOLE_ADMIN_GROUP_ENV } from "@/lib/auth/apps";

import { consoleAdminGroup, isConsoleAdmin } from "./settings";

/**
 * Authorize a console-settings call, or produce the response explaining the refusal.
 *
 * @param req the incoming request.
 * @returns `{ actor, groups }` for a verified console admin, or `{ error }` holding the response to
 *   return unchanged: 401/503 from token verification, or 403 for an authenticated non-admin.
 */
export async function requireConsoleAdmin(
  req: Request,
): Promise<{ actor: string; groups: string[] } | { error: NextResponse }> {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return { error: NextResponse.json({ error: auth.message }, { status: auth.status }) };
  }
  if (!isConsoleAdmin(auth.groups)) {
    const required = consoleAdminGroup();
    return {
      error: NextResponse.json(
        {
          error: required
            ? `this endpoint requires membership of the "${required}" group (${CONSOLE_ADMIN_GROUP_ENV}); ` +
              `${auth.subject} is not a member`
            : `${CONSOLE_ADMIN_GROUP_ENV} is not configured, so no caller can view or change console settings`,
        },
        { status: 403 },
      ),
    };
  }
  return { actor: auth.subject, groups: auth.groups };
}
