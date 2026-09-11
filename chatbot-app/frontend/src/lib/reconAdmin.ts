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
 */

import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";

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
  const required = env.RECON_ADMIN_GROUP;
  if (!required) return false;
  return groups.includes(required);
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
export async function requireReconAdmin(
  req: Request,
): Promise<{ actor: string } | { error: NextResponse }> {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return {
      error: NextResponse.json(
        { error: auth.message },
        { status: auth.status },
      ),
    };
  }
  if (!isReconAdmin(auth.groups)) {
    // The message names the group and the variable. A 403 that says only "forbidden" sends an operator
    // to read this source to find out which group they are missing.
    const required = process.env.RECON_ADMIN_GROUP;
    return {
      error: NextResponse.json(
        {
          error: required
            ? `this endpoint requires membership of the "${required}" group; ${auth.subject} is not a member`
            : "RECON_ADMIN_GROUP is not configured, so no caller can change configuration",
        },
        { status: 403 },
      ),
    };
  }
  return { actor: auth.subject };
}
