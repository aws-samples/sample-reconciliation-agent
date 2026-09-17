/**
 * The one privilege each app distinguishes: who may change how it behaves.
 *
 * Reading is open to every authenticated user the proxy admits; changing what the app does is not.
 * For recon that is the Config tab's writes (the auto-resolve threshold, the agent backend, Tier-1,
 * the addresses the platform may email), memory deletion and uploads; for the pipeline it is
 * approving or rejecting a deal (which invokes the OMS upload), editing staged fields, writing a
 * skill or the parser prompt, deciding a skill proposal, changing memory records and choosing the
 * model. Each one changes what the next run does or what reaches a downstream system, so the check
 * lives in the route handlers — a hidden tab or button is only a courtesy on top of it; the routes
 * answer regardless of what the browser chose to render.
 *
 * Membership is a group claim from the configured OIDC provider (see `api-auth.ts`). There is no
 * Cognito user pool, so no `cognito:groups` to read and no Terraform resource that grants this: an
 * operator adds someone to the group in Okta or Entra, and the next token they get carries it. In
 * local dev, `ALLOW_ANONYMOUS_API=true` grants every configured app group automatically and
 * `ANONYMOUS_GROUPS` narrows that; see `api-auth.ts`.
 *
 * This is the ADMIN half of an app's access model. The ACCESS half — may this caller use the app at
 * all — is decided per request by the proxy from `<APP>_ACCESS_GROUP` (see `lib/auth/apps.ts`), and
 * the admin group implies access there, so an admin never needs to be in both groups.
 *
 * Fails closed when the app's admin group is unset. A deployment that loses the variable locks
 * everyone out of the write routes, which is loud, wrong in the safe direction, and fixed by one env
 * var — where the alternative reading of "unset means unrestricted" would quietly reopen the hole
 * this closes.
 *
 * The group name is read through the registry's `adminGroupFor` (trimmed, blank = unset) rather than
 * straight from `process.env`, so this module and `/api/me`'s `resolveAppAccess` agree
 * byte-for-byte. Before that, a tfvars value with a trailing space made the rail show an admin chip
 * while every write route answered 403 naming a group nobody could see the difference in.
 *
 * One module for both apps, parameterised by `AppId`. The two per-app copies it replaces differed
 * only in the app they named and in the tail of the "not configured" message, which `UNCONFIGURED`
 * keeps per app so neither app's 403 text changed. `reconAdmin.ts` re-exports the recon-named entry
 * points for the recon routes; the pipeline routes call these directly.
 */

import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { adminGroupFor, appById, type AppId, type Env } from "@/lib/auth/apps";
import { effectiveEnv } from "@/lib/console/settings";

/**
 * Whether a caller's groups include the app's configured admin group.
 *
 * @param app the app whose admin group decides.
 * @param groups the caller's verified group memberships.
 * @param env process environment to read `<APP>_ADMIN_GROUP` from (injected in tests).
 * @returns true only when the group is configured AND the caller is in it.
 */
export function isAppAdmin(
  app: AppId,
  groups: readonly string[],
  env: Env = process.env,
): boolean {
  const required = adminGroupFor(app, env);
  if (required === "") return false;
  return groups.includes(required);
}

/**
 * What nobody can do while an app's admin group is unset — the tail of that 403.
 *
 * Per app because each copy worded it for its own writes, and the recon wording is what recon's
 * operators and tests have read since the gate existed.
 */
const UNCONFIGURED: Record<AppId, string> = {
  recon: "change configuration",
  pipeline: "change the pipeline",
};

/** The env var naming `app`'s admin group, for the "not configured" message. */
function adminGroupEnvName(app: AppId): string {
  const def = appById(app);
  // `AppId` is the closed union of registry ids, so this cannot happen; the throw keeps the type
  // honest without a non-null assertion.
  if (!def) throw new Error(`unknown app "${app}"`);
  return def.adminGroupEnv;
}

/** The 403 for an authenticated caller who is not an admin of `app`. */
function forbidden(app: AppId, actor: string, env: Env): NextResponse {
  // The message names the group and the variable. A 403 that says only "forbidden" sends an operator
  // to read this source to find out which group they are missing.
  const required = adminGroupFor(app, env);
  return NextResponse.json(
    {
      error: required
        ? `this endpoint requires membership of the "${required}" group; ${actor} is not a member`
        : `${adminGroupEnvName(app)} is not configured, so no caller can ${UNCONFIGURED[app]}`,
    },
    { status: 403 },
  );
}

interface Verified {
  actor: string;
  groups: string[];
  env: Env;
}

/**
 * Verify the token and read the overlaid environment once: what both public helpers build on.
 *
 * Verifies the token here rather than trusting anything the request carries about who the caller
 * is, matching `requireActor`: a header saying "x-recon-groups: recon-admin" is something a client
 * can send, and a signed token is not.
 */
async function verify(
  req: Request,
): Promise<Verified | { error: NextResponse }> {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return {
      error: NextResponse.json(
        { error: auth.message },
        { status: auth.status },
      ),
    };
  }
  // The overlaid environment (`lib/console/settings.ts`): the process env with the console's stored
  // admin group on top, the same view `/api/me` resolves the rail's admin chip from. Reading
  // `process.env` here instead would let a group changed from the Settings screen show the chip while
  // every write route still answered 403 against the old name.
  return {
    actor: auth.subject,
    groups: auth.groups,
    env: await effectiveEnv(),
  };
}

/**
 * Authorize any authenticated caller and say whether they are also an admin of `app`.
 *
 * For routes every user may call but which must BEHAVE differently for admins. The pipeline
 * assistant is the case that matters: `POST /chat` is open to every reviewer, yet two of its tools
 * (`save_memory`, `delete_memory`) do what the admin-gated `POST`/`DELETE /memory` do. Gating those
 * REST routes while the same writes stay reachable through the chat would make the 403 decorative,
 * so the chat route needs the admin flag alongside the actor — from the same verified token, in one
 * verification.
 *
 * @param app the app whose admin group decides `isAdmin`.
 * @param req the incoming request.
 * @returns `{ actor, isAdmin }` for a verified caller, or `{ error }` holding the 401/503 response
 *   from token verification to return unchanged.
 */
export async function requireAppActor(
  app: AppId,
  req: Request,
): Promise<{ actor: string; isAdmin: boolean } | { error: NextResponse }> {
  const who = await verify(req);
  if ("error" in who) return who;
  return { actor: who.actor, isAdmin: isAppAdmin(app, who.groups, who.env) };
}

/**
 * Authorize a write to `app`, or produce the response explaining the refusal.
 *
 * @param app the app whose admin group decides.
 * @param req the incoming request.
 * @returns `{ actor }` naming the verified caller, or `{ error }` holding the response to return
 *   unchanged — 401/503 from token verification, or 403 when the caller is authenticated but not an
 *   admin.
 */
export async function requireAppAdmin(
  app: AppId,
  req: Request,
): Promise<{ actor: string } | { error: NextResponse }> {
  const who = await verify(req);
  if ("error" in who) return who;
  if (!isAppAdmin(app, who.groups, who.env)) {
    return { error: forbidden(app, who.actor, who.env) };
  }
  return { actor: who.actor };
}
