import { NextResponse } from "next/server";
import {
  BedrockAgentCoreControlClient,
  GetMemoryCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

import { authorizeRequest } from "@/lib/api-auth";
import { toStrategyInfo } from "@/lib/memoryStrategy";

// Same-origin BFF: read the recon memory's STRATEGY CONFIGURATION — which model runs the extraction
// pass and the prompt that decides what counts as a lesson. Read-only, and deliberately so: writing
// here would drift from the Terraform that owns the strategy, and a `type` change replaces the
// strategy, silently deleting every extracted record.
//
// Separate from ../route.ts on purpose. That one is DATA plane (RetrieveMemoryRecords, per
// namespace) and degrades to [] by design; this is CONTROL plane metadata about the memory itself.
// Folding them together would let one failure mode take out the other.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const RECON_MEMORY_ID = process.env.RECON_MEMORY_ID ?? "";

/**
 * Return the live strategy configuration for the recon memory.
 *
 * Authenticated but not admin-gated: it is read-only, it sits beside the records `GET` the Lessons
 * tab already calls, and the prompt is deployed configuration carrying no credentials. Gating it at
 * admin level would hide it from the analysts the panel exists for.
 *
 * @param req the incoming request.
 * @returns `{ configured, memoryStatus, strategies }`, or 401/403 unauthorized, or 500 when
 *   `GetMemory` itself fails.
 */
export async function GET(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  // Feature-gated the same way the records route is: no configured memory is a valid deployment
  // state, not an error, and the panel renders an explicit "not configured" note for it.
  if (!RECON_MEMORY_ID) {
    return NextResponse.json({
      configured: false,
      memoryStatus: null,
      strategies: [],
    });
  }

  try {
    const client = new BedrockAgentCoreControlClient({ region: REGION });
    const resp = await client.send(
      new GetMemoryCommand({ memoryId: RECON_MEMORY_ID }),
    );
    const memory = resp.memory;
    return NextResponse.json({
      configured: true,
      memoryStatus: memory?.status ?? null,
      strategies: (memory?.strategies ?? []).map(toStrategyInfo),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
