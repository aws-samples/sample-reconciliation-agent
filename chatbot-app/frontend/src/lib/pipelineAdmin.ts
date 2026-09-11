/**
 * The one privilege the deal pipeline distinguishes: who may change what the pipeline does.
 *
 * Reading a deal, an email or the skills catalog is open to every authenticated user of the desk.
 * Approving a deal (which invokes the OMS upload), rejecting one, editing staged fields, writing a
 * skill or the parser prompt, deciding a skill proposal, adding or deleting memory records and
 * changing the agent model are not: each one changes how the next deal is parsed or what reaches
 * the OMS. The check lives in the route handlers, so hiding a button in the UI is only a courtesy on
 * top of it — the routes answer regardless of what the browser chose to render.
 *
 * Membership is a group claim from the configured OIDC provider (see `api-auth.ts`). In local dev,
 * `ALLOW_ANONYMOUS_API=true` (or the older `PIPELINE_ALLOW_ANONYMOUS_API=true`, still honoured)
 * grants every configured app group automatically so the demo can be driven end to end without an
 * identity provider; `ANONYMOUS_GROUPS=deal-desk` previews the same screens as a non-admin.
 *
 * This is the ADMIN half of the pipeline's access model. The ACCESS half — may this caller use the
 * app at all — is decided per request by the proxy from `PIPELINE_ACCESS_GROUP` (see
 * `lib/auth/apps.ts`), and the admin group named here implies access there, so an admin never needs
 * to be in both groups.
 *
 * Fails closed when `PIPELINE_ADMIN_GROUP` is unset. A deployment that loses the variable locks
 * everyone out of the write routes, which is loud, wrong in the safe direction, and fixed by one env
 * var — where the alternative reading of "unset means unrestricted" would quietly reopen the hole this
 * closes.
 */

import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";

/**
 * Whether a caller's groups include the configured admin group.
 *
 * @param groups the caller's verified group memberships.
 * @param env process environment to read `PIPELINE_ADMIN_GROUP` from (injected in tests).
 * @returns true only when the group is configured AND the caller is in it.
 */
export function isPipelineAdmin(
  groups: string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  const required = env.PIPELINE_ADMIN_GROUP;
  if (!required) return false;
  return groups.includes(required);
}

/**
 * Authorize any authenticated caller and say whether they are also an admin.
 *
 * For routes every user may call but which must BEHAVE differently for admins. The assistant is the
 * case that matters: `POST /chat` is open to every reviewer, yet two of its tools (`save_memory`,
 * `delete_memory`) do what the admin-gated `POST`/`DELETE /memory` do. Gating those REST routes while
 * the same writes stay reachable through the chat would make the 403 decorative, so the chat route
 * needs the admin flag alongside the actor — from the same verified token, in one verification.
 *
 * Verifies the token here rather than trusting anything the request carries about who the caller is,
 * matching `requireActor`: a header saying "x-pipeline-groups: deal-desk-admins" is something a client
 * can send, and a signed token is not.
 *
 * @param req the incoming request.
 * @returns `{ actor, isAdmin }` for a verified caller, or `{ error }` holding the 401/503 response
 *   from token verification to return unchanged.
 */
export async function requirePipelineActor(
  req: Request,
): Promise<{ actor: string; isAdmin: boolean } | { error: NextResponse }> {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return {
      error: NextResponse.json(
        { error: auth.message },
        { status: auth.status },
      ),
    };
  }
  return { actor: auth.subject, isAdmin: isPipelineAdmin(auth.groups) };
}

/**
 * Authorize a pipeline write, or produce the response explaining the refusal.
 *
 * @param req the incoming request.
 * @returns `{ actor }` naming the verified caller, or `{ error }` holding the response to return
 *   unchanged — 401/503 from token verification, or 403 when the caller is authenticated but not an
 *   admin.
 */
export async function requirePipelineAdmin(
  req: Request,
): Promise<{ actor: string } | { error: NextResponse }> {
  const who = await requirePipelineActor(req);
  if ("error" in who) return who;
  if (!who.isAdmin) {
    // The message names the group and the variable. A 403 that says only "forbidden" sends an operator
    // to read this source to find out which group they are missing.
    const required = process.env.PIPELINE_ADMIN_GROUP;
    return {
      error: NextResponse.json(
        {
          error: required
            ? `this endpoint requires membership of the "${required}" group; ${who.actor} is not a member`
            : "PIPELINE_ADMIN_GROUP is not configured, so no caller can change the pipeline",
        },
        { status: 403 },
      ),
    };
  }
  return { actor: who.actor };
}
