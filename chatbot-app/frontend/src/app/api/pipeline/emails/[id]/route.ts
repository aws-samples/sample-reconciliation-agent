import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { getEmail } from "@/lib/pipeline/server/emailStore";
import { jsonError } from "@/lib/pipeline/server/http";

// One email with its parse output — the Inbox detail view's "raw email beside parsed fields".
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const { id } = await params;
  try {
    const email = await getEmail(id);
    if (!email) return jsonError(404, `email ${id} not found`);
    return NextResponse.json(email);
  } catch (err) {
    return jsonError(500, `email read failed: ${(err as Error).message}`);
  }
}
