import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { toCsv } from "@/lib/pipeline/omsSchema";
import { getDeal } from "@/lib/pipeline/server/dealStore";
import { jsonError } from "@/lib/server/http";

// The staging CSV as a download.
//
// Generated from the deal's current fields with the same `toCsv` that writes the S3 copy on every
// edit, so the two agree by construction and the route needs no S3 round trip.
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const { id } = await params;
  try {
    const deal = await getDeal(id);
    if (!deal) return jsonError(404, `deal ${id} not found`);
    return new NextResponse(toCsv(deal.fields), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${deal.deal_id}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(500, `csv read failed: ${(err as Error).message}`);
  }
}
