import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { requirePipelineAdmin } from "@/lib/pipelineAdmin";
import type { FieldValues } from "@/lib/pipeline/types";
import { normalizeFields, validateFields } from "@/lib/pipeline/omsSchema";
import { isConditionalCheckFailed } from "@/lib/pipeline/server/aws";
import { applyEdit, getDeal, isOpen } from "@/lib/pipeline/server/dealStore";
import { jsonError, readJsonObject } from "@/lib/pipeline/server/http";
import { parseFieldsBody } from "@/lib/pipeline/server/requests";

// One deal: read it, or edit its staged fields before approval (design §9).
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
    return NextResponse.json(deal);
  } catch (err) {
    return jsonError(500, `deal read failed: ${(err as Error).message}`);
  }
}

/**
 * Edit staged fields.
 *
 * Admin-gated: an edit changes what the OMS receives on approve. The merged record is validated
 * against the schema formats (§5) and refused whole with per-field `problems` when anything is
 * off — the OMS would reject the same values with `FORMAT_INVALID`, and catching it here keeps
 * the learning loop for the rules the validator alone knows about.
 *
 * @returns the updated deal; 400 `{error, problems}`; 404; 409 when the deal is UPLOADED/REJECTED,
 *   or when its status changed between this request's read and its write.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requirePipelineAdmin(req);
  if ("error" in admin) return admin.error;
  const { id } = await params;

  let partial: Partial<FieldValues>;
  try {
    partial = parseFieldsBody(await readJsonObject(req));
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  try {
    const deal = await getDeal(id);
    if (!deal) return jsonError(404, `deal ${id} not found`);
    if (!isOpen(deal)) {
      return jsonError(409, `deal ${id} is ${deal.status} and can no longer be edited`);
    }
    const merged = normalizeFields({ ...deal.fields, ...partial });
    const problems = validateFields(merged);
    if (Object.keys(problems).length > 0) {
      return jsonError(400, "some fields are invalid", { problems });
    }
    return NextResponse.json(await applyEdit(deal, merged, admin.actor));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // Another writer (a decision, the OMS Lambda) moved the deal on since we read it. The edit was
      // not recorded; the caller reloads and decides again against the current state.
      return jsonError(409, `deal ${id} changed while this edit was in flight; reload and try again`);
    }
    return jsonError(500, `deal edit failed: ${(err as Error).message}`);
  }
}
