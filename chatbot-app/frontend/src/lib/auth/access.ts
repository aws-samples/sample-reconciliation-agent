/**
 * The per-app access decision the proxy applies to an authenticated BFF request.
 *
 * Pure and environment-injectable so the rule can be tested as a table without constructing
 * `NextRequest`s: given a path and the caller's verified groups, either the request may proceed or
 * here is the 403 to return. The proxy is the only production caller today, but the decision is kept
 * out of `proxy.ts` because Next bundles that file separately and a route handler that ever wants
 * the same check (defense in depth, the way `/api/me` re-runs `authorizeRequest`) should import a
 * function rather than duplicate the string.
 */

import {
  accessGroupFor,
  appForApiPath,
  isAppEnabled,
  resolveAppAccess,
  type AppDefinition,
} from "@/lib/auth/apps";

export type ApiAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 403; message: string };

/**
 * The 403 body for a call to an app that is not deployed on this console.
 *
 * A 403 rather than a 404: the client already handles a 403 body from this gate (the shell renders
 * it), and a 404 here would be indistinguishable from a mistyped route. Names the app, not a group,
 * because no group would help.
 *
 * @param app the app whose API prefix owns the request.
 */
export function appDisabledMessage(app: AppDefinition): string {
  return `${app.label} is not enabled on this deployment`;
}

/**
 * The 403 body for an authenticated caller outside an app's access group.
 *
 * Names the app and the group. A 403 that says only "forbidden" sends the operator to read this
 * source to find out which group to request; naming the group lets the shell show it, and lets a
 * support ticket carry it. When no group is configured at all the refusal can only have come from
 * `REQUIRE_ACCESS_GROUPS`, so the wording names that switch and the variable the operator must set
 * instead of a blank group name.
 *
 * @param app the app whose API prefix owns the request.
 * @param env process environment to read the group name from (injected in tests).
 */
export function accessDeniedMessage(
  app: AppDefinition,
  env: Record<string, string | undefined> = process.env,
): string {
  const group = accessGroupFor(app, env);
  if (group === "") {
    return (
      `no access to ${app.label}: ${app.accessGroupEnv} is not configured and ` +
      `REQUIRE_ACCESS_GROUPS is true, so only members of its admin group may use it`
    );
  }
  return `no access to ${app.label}: membership of the ${group} group is required`;
}

/**
 * Decide whether an authenticated caller may reach `pathname`.
 *
 * Paths outside every app's API prefix (`/api/me`) are allowed on authentication alone: the shell
 * calls `/api/me` to learn WHICH apps to show, so it must answer for a caller who has access to none
 * of them. App-prefixed paths are refused outright when the app is not deployed (checked first, so a
 * disabled app's routes never run against another app's resources), and otherwise require the app's
 * access group, or its admin group, which implies access (`resolveAppAccess`).
 *
 * @param pathname the request path, e.g. `/api/recon/cases/1`.
 * @param groups the caller's verified group memberships.
 * @param env process environment to read the group names and switches from (injected in tests).
 */
export function decideApiAccess(
  pathname: string,
  groups: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ApiAccessDecision {
  const app = appForApiPath(pathname);
  if (!app) return { allowed: true };
  if (!isAppEnabled(app, env)) {
    return { allowed: false, status: 403, message: appDisabledMessage(app) };
  }
  if (resolveAppAccess(groups, env)[app.id].access) return { allowed: true };
  return { allowed: false, status: 403, message: accessDeniedMessage(app, env) };
}
