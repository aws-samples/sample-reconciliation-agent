import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { jsonError } from "@/lib/server/http";
import { getStrategy } from "@/lib/pipeline/server/memoryClient";

// The knowledge memory's STRATEGY configuration — which model runs the extraction pass and the
// prompt that decides what counts as a reusable rule. Read-only, and deliberately so: writing here
// would drift from the Terraform that owns the strategy, and a `type` change replaces the strategy,
// silently deleting every extracted record.
//
// Separate from ../route.ts on purpose. That one is DATA plane and degrades to [] by design; this is
// CONTROL plane metadata about the memory itself. Folding them together would let one failure mode
// take out the other.
export const runtime = "nodejs";

/** @returns `{ configured, memoryStatus, strategies }`. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    return NextResponse.json(await getStrategy());
  } catch (err) {
    return jsonError(500, `memory strategy read failed: ${(err as Error).message}`);
  }
}
