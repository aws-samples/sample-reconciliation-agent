/**
 * Deny-by-default gate in front of the reconciliation BFF.
 *
 * Every request to `/api/recon/*` is verified here BEFORE the route handler runs, so a new route
 * added under that prefix is protected without anyone remembering to protect it. This is the fix
 * for live-QA finding P0-2 (the BFF was reachable anonymously, including the system-prompt PUT
 * and the case-approval POST, both of which act with the ECS task role).
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 deprecated the `middleware` file convention in
 * favour of `proxy` and warns on every build. The rename is also what makes this correct rather
 * than merely tidy — a `proxy` ALWAYS runs on the Node.js runtime (Next rejects a `runtime` key
 * here outright), whereas `middleware` defaulted to Edge. Edge would break this gate: Next inlines
 * `process.env` references into Edge bundles at BUILD time, but the auth configuration
 * (`AUTH_PROVIDER`/`OKTA_ISSUER`/`OKTA_CLIENT_ID`) is supplied at RUNTIME by the ECS task
 * definition, so on Edge those reads would bake in as undefined and every request would 503.
 *
 * Node-runtime interceptors are registered in `.next/server/functions-config-manifest.json` (as
 * `/_middleware`), NOT in the top-level `middleware-manifest.json`, which only ever lists EDGE
 * interceptors and is therefore empty here. An empty middleware-manifest is not a sign the gate
 * is missing; verify by hitting the running server instead (see the design doc's probe script).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const result = await authorizeRequest(request);
  if (result.ok) return NextResponse.next();

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

export const config = {
  // No `runtime` key: Next rejects one in a proxy file because a proxy is always Node.js.
  // Scoped to the recon BFF only. The chatbot app's own /api routes are a separate ingress with
  // its own auth story; widening this matcher would change behaviour the QA did not assess.
  matcher: ["/api/recon/:path*"],
};
