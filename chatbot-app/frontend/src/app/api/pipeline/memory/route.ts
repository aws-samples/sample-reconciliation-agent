import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { requirePipelineAdmin } from "@/lib/pipelineAdmin";
import { jsonError, readJsonObject, stringField } from "@/lib/pipeline/server/http";
import { newProposalId } from "@/lib/pipeline/server/ids";
import {
  batchDelete,
  createRuleEvent,
  EDGE_CASES_NAMESPACE,
  listRecords,
} from "@/lib/pipeline/server/memoryClient";
import { parseMemoryDeleteIds } from "@/lib/pipeline/server/requests";

// The Memory Manager (design §8, §9): the consolidated edge-case records the parser recalls before
// every run — list them, add a rule by hand, delete the ones an operator selects.
//
// GET is open to every authenticated user, because anyone who reviews deals is entitled to know
// what the parser has been taught. POST and DELETE are admin-gated, because both change what the
// next parse does.
export const runtime = "nodejs";

/** @returns `MemoryRecord[]` — `[]` when the knowledge memory is not configured. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    return NextResponse.json(await listRecords(EDGE_CASES_NAMESPACE));
  } catch (err) {
    return jsonError(500, `memory list failed: ${(err as Error).message}`);
  }
}

/**
 * Add a rule by hand — the same event the assistant's `save_memory` writes.
 *
 * @returns 202 `{ event_id }`: the strategy extracts the record asynchronously, so the rule is not
 *   listable yet; 400 without a `rule`; 409 when the knowledge memory is not configured.
 */
export async function POST(req: Request) {
  const admin = await requirePipelineAdmin(req);
  if ("error" in admin) return admin.error;
  const body = await readJsonObject(req);
  const rule = body ? stringField(body, "rule") : undefined;
  if (!rule) return jsonError(400, "rule is required");
  const rationale = (body && stringField(body, "rationale")) ?? "";
  try {
    // One session per manual add: there is no conversation to group it with.
    const eventId = await createRuleEvent(rule, rationale, `manual-${newProposalId()}`);
    if (eventId === null) {
      return jsonError(409, "KNOWLEDGE_MEMORY_ID is not configured, so there is no memory to write to");
    }
    return NextResponse.json({ event_id: eventId }, { status: 202 });
  } catch (err) {
    return jsonError(500, `memory add failed: ${(err as Error).message}`);
  }
}

/**
 * Delete consolidated records the operator selected.
 *
 * Returns 200 with a non-empty `failed` list on a partial failure — the UI shows which records
 * survived. A blanket 500 would leave the operator unable to tell which of their selection is gone.
 *
 * @returns `{ deleted, failed }`; 400 bad body; 409 when no memory is configured (a delete that
 *   deleted nothing must not look like a success).
 */
export async function DELETE(req: Request) {
  const admin = await requirePipelineAdmin(req);
  if ("error" in admin) return admin.error;

  let ids: string[];
  try {
    ids = parseMemoryDeleteIds(await readJsonObject(req));
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  try {
    const outcome = await batchDelete(ids);
    if (outcome === null) {
      return jsonError(409, "KNOWLEDGE_MEMORY_ID is not configured, so there is no memory to delete from");
    }
    return NextResponse.json(outcome);
  } catch (err) {
    return jsonError(500, `memory delete failed: ${(err as Error).message}`);
  }
}
