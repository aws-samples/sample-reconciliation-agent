import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { jsonError } from "@/lib/pipeline/server/http";
import { listSamples } from "@/lib/pipeline/server/samples";

// The simulated inbox's menu: the fictional corpus from `SAMPLE_EMAILS_DIR` on disk, or from the
// bucket's `samples/` prefix when the directory is absent, as in the container (design §9).
export const runtime = "nodejs";

/** @returns `SampleEmail[]` in corpus order. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    return NextResponse.json(await listSamples());
  } catch (err) {
    return jsonError(500, `samples list failed: ${(err as Error).message}`);
  }
}
