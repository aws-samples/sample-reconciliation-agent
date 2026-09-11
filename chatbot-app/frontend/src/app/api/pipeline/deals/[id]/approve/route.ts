import { NextResponse } from "next/server";

import { requirePipelineAdmin } from "@/lib/pipelineAdmin";
import { isConditionalCheckFailed } from "@/lib/pipeline/server/aws";
import {
  getDeal,
  isOpen,
  markApproved,
  recordUpload,
  toUploadResult,
  type UploadLambdaResult,
} from "@/lib/pipeline/server/dealStore";
import { env } from "@/lib/pipeline/server/env";
import { jsonError } from "@/lib/pipeline/server/http";
import { invokeSync } from "@/lib/pipeline/server/lambdaInvoke";

// Approve a staged deal and push it to the (mock) OMS (design §9).
//
// The sequence is: record APPROVED with the reviewer's name, invoke the OMS upload Lambda
// synchronously, then read the deal back. The Lambda validates the staging CSV and normally
// persists the verdict itself (UPLOADED / UPLOAD_FAILED, `upload`, history). If it returned a
// verdict but left the row APPROVED, the BFF records the verdict from the response, so the outcome
// reaches the deal either way.
//
// The read-back is a strongly consistent read. It is issued the instant the Lambda's UpdateItem
// returns, which is inside the window an eventually-consistent GetItem may still show the
// pre-update row — and the fallback branch below is keyed on exactly that stale state, so without
// consistency it would fire on a lag rather than a fault and re-attribute the Lambda's history row
// to the reviewer.
export const runtime = "nodejs";

/**
 * @returns the deal after upload (UPLOADED or UPLOAD_FAILED); 404; 409 when it is already
 *   UPLOADED or REJECTED, or when another decision landed between this request's read and its
 *   write; 502 with `{error, deal}` when the Lambda could not be invoked, leaving the deal APPROVED
 *   so the reviewer can retry.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requirePipelineAdmin(req);
  if ("error" in admin) return admin.error;
  const { id } = await params;

  try {
    const deal = await getDeal(id);
    if (!deal) return jsonError(404, `deal ${id} not found`);
    if (!isOpen(deal)) {
      return jsonError(409, `deal ${id} is ${deal.status} and cannot be approved`);
    }
    const approved = await markApproved(deal, admin.actor);

    let result: UploadLambdaResult;
    try {
      result = await invokeSync<UploadLambdaResult>(env.omsUploadFunction(), { deal_id: id });
    } catch (err) {
      return jsonError(502, `OMS upload failed: ${(err as Error).message}`, { deal: approved });
    }

    const reloaded = (await getDeal(id, { consistent: true })) ?? approved;
    if (reloaded.status !== "APPROVED") return NextResponse.json(reloaded);
    try {
      return NextResponse.json(await recordUpload(reloaded, toUploadResult(result), admin.actor));
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      // The Lambda's own write landed between the reload and ours. Its verdict is authoritative;
      // return what it wrote rather than a second copy attributed to the reviewer.
      return NextResponse.json((await getDeal(id, { consistent: true })) ?? reloaded);
    }
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // Someone else decided this deal between our read and our APPROVED write; the Lambda was
      // never invoked, so nothing reached the OMS on our account.
      return jsonError(409, `deal ${id} changed while this request was in flight; reload and try again`);
    }
    return jsonError(500, `approve failed: ${(err as Error).message}`);
  }
}
