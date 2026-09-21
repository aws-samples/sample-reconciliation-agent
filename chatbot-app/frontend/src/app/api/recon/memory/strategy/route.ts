import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/api-auth";
import { reconMemoryClient } from "@/lib/reconMemory";

// Same-origin BFF: read the recon memory's STRATEGY CONFIGURATION — which model runs the extraction
// pass and the prompt that decides what counts as a lesson. Read-only, and deliberately so: writing
// here would drift from the Terraform that owns the strategy, and a `type` change replaces the
// strategy, silently deleting every extracted record.
//
// Separate from ../route.ts on purpose. That one is DATA plane (RetrieveMemoryRecords, per
// namespace) and degrades to [] by design; this is CONTROL plane metadata about the memory itself.
// Folding them together would let one failure mode take out the other.
//
// The GetMemory call and its projection are the shared client's (lib/server/memoryClient.ts), bound
// to RECON_MEMORY_ID by lib/reconMemory.ts; the error envelope here stays recon's raw message.
export const runtime = "nodejs";

/**
 * Return the live strategy configuration for the recon memory.
 *
 * Authenticated but not admin-gated: it is read-only, it sits beside the records `GET` the Lessons
 * tab already calls, and the prompt is deployed configuration carrying no credentials. Gating it at
 * admin level would hide it from the analysts the panel exists for.
 *
 * @param req the incoming request.
 * @returns `{ configured, memoryStatus, strategies }` — `configured: false` with no strategies when
 *   no memory is configured, which is a valid deployment state rather than an error — or 401/403
 *   unauthorized, or 500 when `GetMemory` itself fails.
 */
export async function GET(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  try {
    return NextResponse.json(await reconMemoryClient().getStrategy());
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
