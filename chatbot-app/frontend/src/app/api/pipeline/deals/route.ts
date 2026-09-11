import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { listDeals } from "@/lib/pipeline/server/dealStore";
import { jsonError } from "@/lib/pipeline/server/http";

// Staged deals, newest first. `?limit=N` caps the list for callers that only want the latest.
export const runtime = "nodejs";

export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const limitRaw = new URL(req.url).searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return jsonError(400, "limit must be a positive integer");
  }
  try {
    return NextResponse.json(await listDeals(limit));
  } catch (err) {
    return jsonError(500, `deals list failed: ${(err as Error).message}`);
  }
}
