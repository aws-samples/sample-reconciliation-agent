/**
 * Deny-by-default gate in front of the shell's BFF: `/api/recon/*`, `/api/pipeline/*`,
 * `/api/console/*` and `/api/me`.
 *
 * Every matched request is checked here BEFORE the route handler runs, so a new route added under
 * either app's prefix is protected without anyone remembering to protect it. Two checks, in order:
 *
 *  1. Authentication — the caller presents a verifiable token, or the deployment is in anonymous
 *     mode. A failure is the 401 or 503 that `authorizeRequest` decided; the distinction matters
 *     because one means "sign in again" and the other means "the server is misconfigured or the
 *     identity provider is unreachable", and a client that retries the wrong one loops.
 *  2. Per-app access — an app-prefixed path additionally needs the app to be deployed
 *     (`PIPELINE_ENABLED` is not "false") and the caller in that app's access group (or its admin
 *     group, which implies access). An app whose access group is unset stays open to every
 *     authenticated user, so a deployment that predates the shell behaves exactly as it did — unless
 *     `REQUIRE_ACCESS_GROUPS=true`, which the composed deployment sets because "every authenticated
 *     user" then includes the other app's desk; an unset group is admins-only there. `/api/me` and
 *     `/api/console/*` are not app-prefixed and stop at step 1: the shell calls `/api/me` to learn
 *     WHICH apps to show, so it must answer for a caller who may use none of them, and the console
 *     routes gate their own admin-only operations against `CONSOLE_ADMIN_GROUP` themselves. The
 *     rules live in `lib/auth/apps.ts`.
 *
 * The group names and the enablement flag come from `effectiveEnv()` (`lib/console/settings.ts`):
 * the process environment with the console's stored settings overlaid, so an access group changed
 * from the Settings screen applies here without a redeploy. The overlay is cached in-process for 30
 * seconds and Next bundles this file separately from the route handlers, so a change saved through
 * `PUT /api/console/settings` reaches this gate within that window rather than immediately. When the
 * stored layer is unset or unreadable the environment alone is used, exactly as before the layer
 * existed.
 *
 * This is the fix for live-QA finding P0-2 (the recon BFF was reachable anonymously, including the
 * system-prompt PUT and the case-approval POST, both of which act with the ECS task role), widened
 * to the pipeline BFF when the two apps came to share a server.
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 deprecated the `middleware` file convention in
 * favour of `proxy` and warns on every build. The rename is also what makes this correct rather
 * than merely tidy — a `proxy` ALWAYS runs on the Node.js runtime (Next rejects a `runtime` key
 * here outright), whereas `middleware` defaulted to Edge. Edge would break this gate: Next inlines
 * `process.env` references into Edge bundles at BUILD time, but the auth configuration
 * (`AUTH_PROVIDER`/`OKTA_ISSUER`/`OKTA_CLIENT_ID`) and the group names (`RECON_ACCESS_GROUP` and
 * friends) are supplied at RUNTIME by the ECS task definition, so on Edge those reads would bake in
 * as undefined and every request would 503, or every app would read as open.
 *
 * Node-runtime interceptors are registered in `.next/server/functions-config-manifest.json` (as
 * `/_middleware`), NOT in the top-level `middleware-manifest.json`, which only ever lists EDGE
 * interceptors and is therefore empty here. An empty middleware-manifest is not a sign the gate
 * is missing; verify by hitting the running server with and without a token instead.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { decideApiAccess } from "@/lib/auth/access";
import { effectiveEnv } from "@/lib/console/settings";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const result = await authorizeRequest(request);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message },
      {
        status: result.status,
        headers:
          result.status === 401
            ? // Tells the browser/CLI what to send; no `realm` since there is nothing to prompt for.
              { "WWW-Authenticate": "Bearer" }
            : {},
      },
    );
  }

  const access = decideApiAccess(request.nextUrl.pathname, result.groups, await effectiveEnv());
  if (!access.allowed) {
    // 403 rather than 401: the token is fine and signing in again will not help. The body names the
    // app and the group so the shell (and a support ticket) can say what to request.
    return NextResponse.json({ error: access.message }, { status: access.status });
  }

  return NextResponse.next();
}

export const config = {
  // No `runtime` key: Next rejects one in a proxy file because a proxy is always Node.js.
  // Scoped to the two app BFFs, the console's settings routes and the shell's identity route. The
  // chatbot app's own /api routes are a separate ingress with its own auth story; widening this
  // matcher to them would change behaviour the QA did not assess. Matchers must be literal so Next
  // can read them at build time, which is why this list is not derived from the APPS registry.
  matcher: ["/api/recon/:path*", "/api/pipeline/:path*", "/api/console/:path*", "/api/me"],
};
