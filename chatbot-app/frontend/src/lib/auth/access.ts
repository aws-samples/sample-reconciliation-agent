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
  appForApiPath,
  resolveAppAccess,
  type AppDefinition,
} from "@/lib/auth/apps";

export type ApiAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 403; message: string };

/**
 * The 403 body for a caller outside an app's access group.
 *
 * Names the app and the group. A 403 that says only "forbidden" sends the operator to read this
 * source to find out which group to request; naming the group lets the shell show it, and lets a
 * support ticket carry it. Only ever built when the access group is SET (an unset group is open to
 * everyone, so there is nothing to be outside of), which is why the empty-group case needs no
 * wording of its own.
 *
 * @param app the app whose API prefix owns the request.
 * @param env process environment to read the group name from (injected in tests).
 */
export function accessDeniedMessage(
  app: AppDefinition,
  env: Record<string, string | undefined> = process.env,
): string {
  const group = env[app.accessGroupEnv]?.trim() ?? "";
  return `no access to ${app.label}: membership of the ${group} group is required`;
}

/**
 * Decide whether an authenticated caller may reach `pathname`.
 *
 * Paths outside every app's API prefix (`/api/me`) are allowed on authentication alone: the shell
 * calls `/api/me` to learn WHICH apps to show, so it must answer for a caller who has access to none
 * of them. App-prefixed paths additionally require the app's access group, or its admin group, which
 * implies access (`resolveAppAccess`).
 *
 * @param pathname the request path, e.g. `/api/recon/cases/1`.
 * @param groups the caller's verified group memberships.
 * @param env process environment to read the group names from (injected in tests).
 */
export function decideApiAccess(
  pathname: string,
  groups: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ApiAccessDecision {
  const app = appForApiPath(pathname);
  if (!app) return { allowed: true };
  if (resolveAppAccess(groups, env)[app.id].access) return { allowed: true };
  return { allowed: false, status: 403, message: accessDeniedMessage(app, env) };
}
