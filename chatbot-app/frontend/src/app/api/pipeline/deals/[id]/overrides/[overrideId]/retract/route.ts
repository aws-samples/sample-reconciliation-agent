import { NextResponse } from "next/server";

import { requireAppActor } from "@/lib/auth/app-admin";
import { overridesOf } from "@/lib/pipeline/overrides";
import { isConditionalCheckFailed } from "@/lib/pipeline/server/aws";
import { getDeal, markLessonsRetracted } from "@/lib/pipeline/server/dealStore";
import { batchDelete, recordsForOverride } from "@/lib/pipeline/server/memoryClient";
import { jsonError } from "@/lib/server/http";

// Retract the lesson one override taught (design §8, §9).
//
// Overrides are open to every pipeline user and each one teaches the parser without review, so the
// person who made it can take the lesson back — and so can an admin, who prunes everyone's. The
// lesson's records are found by the override id the strategy copied onto them, so exactly that
// lesson goes and nothing it happens to resemble. The override itself, and the value it set on this
// deal, stay: what is withdrawn is what the parser learned from it.
export const runtime = "nodejs";

/**
 * @returns the updated deal (the override's memory now `retracted`, a LESSON_RETRACTED history row);
 *   403 when the caller is neither the override's author nor a pipeline admin; 404 for an unknown
 *   deal or override; 409 when there is no lesson to retract — none was sent, it is already
 *   retracted, or no record carries this override id yet (still being extracted, or it did not
 *   generalise) — or when the deal kept changing under the write.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; overrideId: string }> },
) {
  const who = await requireAppActor("pipeline", req);
  if ("error" in who) return who.error;
  const { id, overrideId } = await params;
  let deletedCount = 0;

  try {
    const deal = await getDeal(id, { consistent: true });
    if (!deal) return jsonError(404, `deal ${id} not found`);
    const override = overridesOf(deal).find((o) => o.override_id === overrideId);
    if (!override) return jsonError(404, `override ${overrideId} not found on deal ${id}`);
    if (override.actor !== who.actor && !who.isAdmin) {
      return jsonError(403, "only the override's author or a pipeline admin can retract its lesson");
    }
    if (override.memory.status === "retracted") {
      return jsonError(409, "this override's lesson was already retracted");
    }
    if (override.memory.status !== "sent") {
      return jsonError(409, `this override sent no lesson to retract (memory: ${override.memory.status})`);
    }

    const records = await recordsForOverride(overrideId);
    if (records.length === 0) {
      return jsonError(
        409,
        "no lesson record carries this override yet: extraction takes 1–3 minutes, and a reason that did not generalise yields none. Try again shortly.",
      );
    }
    const outcome = await batchDelete(records.map((r) => r.id));
    if (outcome === null) {
      return jsonError(409, "KNOWLEDGE_MEMORY_ID is not configured, so there is no memory to delete from");
    }
    if (outcome.deleted.length === 0) {
      return jsonError(502, `the lesson's records could not be deleted: ${outcome.failed.map((f) => f.error).join("; ")}`);
    }
    deletedCount = outcome.deleted.length;
    const updated = await markLessonsRetracted(deal, { [overrideId]: deletedCount }, who.actor);
    return NextResponse.json(updated);
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // After a delete the lesson is gone whatever the deal says; a retry would find no record and
      // refuse, so say what actually happened rather than inviting one.
      return jsonError(
        409,
        deletedCount > 0
          ? `the lesson was deleted from memory, but deal ${id} changed while recording it, so the override may still show it as sent`
          : `deal ${id} changed while the retract was in flight; reload and try again`,
      );
    }
    return jsonError(500, `retract failed: ${(err as Error).message}`);
  }
}
