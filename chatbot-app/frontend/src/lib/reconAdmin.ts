/**
 * The one privilege the recon console distinguishes: who may change how it behaves.
 *
 * Until this existed, every authenticated user could move the auto-resolve threshold, switch the agent
 * backend, disable Tier-1, and edit the list of addresses the platform may email. That is not a UI
 * problem — the Config tab could be hidden and the routes would still answer — so the check lives in the
 * route handlers, and the tab being hidden is only a courtesy on top of it.
 *
 * Membership is a group claim from the configured OIDC provider. The console has no Cognito user pool
 * (see `api-auth.ts`), so there is no `cognito:groups` to read and no Terraform resource that grants
 * this: an operator adds someone to the group in Okta or Entra, and the next token they get carries it.
 *
 * This is the ADMIN half of the recon app's access model. The ACCESS half — may this caller use the
 * app at all — is decided per request by the proxy from `RECON_ACCESS_GROUP` (see `lib/auth/apps.ts`),
 * and the admin group named here implies access there, so an admin never needs to be in both groups.
 * In local dev, `ALLOW_ANONYMOUS_API=true` grants this group automatically and `ANONYMOUS_GROUPS`
 * narrows that; see `api-auth.ts`.
 *
 * Fails closed when `RECON_ADMIN_GROUP` is unset. A deployment that loses the variable locks everyone
 * out of the Config tab, which is loud, wrong in the safe direction, and fixed by one env var — where
 * the alternative reading of "unset means unrestricted" would quietly reopen the hole this closes.
 *
 * The group name is read through the registry's `adminGroupFor` (trimmed, blank = unset) rather than
 * straight from `process.env`, so this helper and `/api/me`'s `resolveAppAccess` agree byte-for-byte.
 * Before that, a tfvars value with a trailing space made the rail show an admin chip while every
 * write route answered 403 naming a group nobody could see the difference in.
 *
 * The implementation is `lib/auth/app-admin.ts`, shared with the pipeline and parameterised by app;
 * this module keeps the recon-named entry points so the recon routes and their tests read as before.
 */

import type { NextResponse } from "next/server";

import { isAppAdmin, requireAppAdmin } from "@/lib/auth/app-admin";

/**
 * Whether a caller's groups include the configured admin group.
 *
 * @param groups the caller's verified group memberships.
 * @param env process environment to read `RECON_ADMIN_GROUP` from (injected in tests).
 * @returns true only when the group is configured AND the caller is in it.
 */
export function isReconAdmin(
  groups: string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isAppAdmin("recon", groups, env);
}

/**
 * Authorize a configuration change, or produce the response explaining the refusal.
 *
 * Verifies the token here rather than trusting anything the request carries about who the caller is,
 * matching `requireActor`: a header saying "x-recon-groups: recon-admin" is something a client can send,
 * and a signed token is not.
 *
 * @param req the incoming request.
 * @returns `{ actor }` naming the verified caller, or `{ error }` holding the response to return
 *   unchanged — 401/503 from token verification, or 403 when the caller is authenticated but not an
 *   admin.
 */
export function requireReconAdmin(
  req: Request,
): Promise<{ actor: string } | { error: NextResponse }> {
  return requireAppAdmin("recon", req);
}
