import { NextResponse } from "next/server";

import { requireAppAdmin } from "@/lib/auth/app-admin";
import { isConditionalCheckFailed } from "@/lib/pipeline/server/aws";
import { getDeal, isOpen, markRejected } from "@/lib/pipeline/server/dealStore";
import { jsonError, readJsonObject, stringField } from "@/lib/server/http";

// Reject a staged deal with a reason. The reason is required: a rejection with no rationale is
// the one decision the learning loop can do nothing with.
export const runtime = "nodejs";

/**
 * @returns the REJECTED deal; 400 without a reason; 404; 409 when already UPLOADED/REJECTED, or
 *   when the status changed between this request's read and its write (an approve that is mid-upload
 *   must not be overwritten by a rejection — the file is already on its way to the OMS).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAppAdmin("pipeline", req);
  if ("error" in admin) return admin.error;
  const { id } = await params;

  const body = await readJsonObject(req);
  const reason = body ? stringField(body, "reason") : undefined;
  if (!reason) return jsonError(400, "reason is required");

  try {
    const deal = await getDeal(id);
    if (!deal) return jsonError(404, `deal ${id} not found`);
    if (!isOpen(deal)) {
      return jsonError(409, `deal ${id} is ${deal.status} and cannot be rejected`);
    }
    return NextResponse.json(await markRejected(deal, reason, admin.actor));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return jsonError(409, `deal ${id} changed while this request was in flight; reload and try again`);
    }
    return jsonError(500, `reject failed: ${(err as Error).message}`);
  }
}
