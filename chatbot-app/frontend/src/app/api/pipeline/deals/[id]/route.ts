import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import type { FieldValues, OverrideMemory } from "@/lib/pipeline/types";
import { changedKeys, fieldDef, normalizeFields, validateFieldValue } from "@/lib/pipeline/omsSchema";
import { isConditionalCheckFailed } from "@/lib/pipeline/server/aws";
import {
  applyOverrides,
  getDeal,
  isOpen,
  recordOverrideMemory,
} from "@/lib/pipeline/server/dealStore";
import { getEmail } from "@/lib/pipeline/server/emailStore";
import { createOverrideEvent } from "@/lib/pipeline/server/memoryClient";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { parseOverrideBody, type OverrideRequest } from "@/lib/pipeline/server/requests";

// One deal: read it, or override its staged fields before approval (design §9).
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
 * Override staged fields, each with the reviewer's reason.
 *
 * Open to everyone with pipeline access: correcting the parser is the desk's daily work, and the
 * proxy has already matched the caller against the pipeline's access group. Approving and rejecting
 * stay admin-gated in their own routes.
 *
 * Every field whose value changes must come with a reason, which is recorded on the deal and sent
 * to the knowledge memory as a lesson for the next parse. Only the changed values are validated
 * against the schema formats (§5): an override of one field must not be refused because the parser
 * left another blank, and the OMS still validates the whole file on upload.
 *
 * The lessons are sent after the deal write succeeds, so the memory never learns from an override
 * the deal did not keep. A memory failure does not fail the request — the override stands, and its
 * `memory.status` says the lesson did not arrive.
 *
 * @returns the updated deal; 400 `{error, problems?}`; 404; 409 when the deal is UPLOADED/REJECTED,
 *   or when it changed between this request's read and its write.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const { id } = await params;

  let body: OverrideRequest;
  try {
    body = parseOverrideBody(await readJsonObject(req));
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  try {
    // Strongly consistent: the write below is guarded on `updated_at`, and the override just before
    // this one moved it twice (its own write, then the memory outcome) inside the lag window.
    const deal = await getDeal(id, { consistent: true });
    if (!deal) return jsonError(404, `deal ${id} not found`);
    if (!isOpen(deal)) {
      return jsonError(409, `deal ${id} is ${deal.status} and can no longer be edited`);
    }
    const merged: FieldValues = normalizeFields({ ...deal.fields, ...body.fields });
    const changed = changedKeys(deal.fields, merged);
    if (changed.length === 0) return jsonError(400, "no field changes");

    const problems: Record<string, string> = {};
    for (const key of changed) {
      const problem = validateFieldValue(fieldDef(key)!, merged[key]);
      if (problem) problems[key] = problem;
    }
    if (Object.keys(problems).length > 0) {
      return jsonError(400, "some fields are invalid", { problems });
    }
    const missing = changed.filter((key) => !body.reasons[key]);
    if (missing.length > 0) {
      return jsonError(400, `a reason is required for every overridden field: ${missing.join(", ")}`, {
        problems: Object.fromEntries(missing.map((key) => [key, "reason required"])),
      });
    }

    const written = await applyOverrides(deal, merged, body.reasons, who.actor);
    const email = await getEmail(deal.email_id).catch(() => null);
    const outcomes: Record<string, OverrideMemory> = {};
    await Promise.all(
      written.added.map(async (override) => {
        try {
          const eventId = await createOverrideEvent(override, deal.deal_id, {
            email,
            fields: written.deal.fields,
            evidence: deal.evidence[override.field],
          });
          outcomes[override.override_id] =
            eventId === null ? { status: "off" } : { status: "sent", event_id: eventId };
        } catch (err) {
          outcomes[override.override_id] = { status: "failed", error: (err as Error).message };
        }
      }),
    );
    try {
      return NextResponse.json(await recordOverrideMemory(written.deal, outcomes));
    } catch {
      // The overrides and the lessons both landed; only the bookkeeping write failed. Answer with
      // the deal as stored, whose new overrides still say `pending` — true of the record, if not of
      // the memory.
      return NextResponse.json(written.deal);
    }
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // Another writer (a second reviewer, a decision, the OMS Lambda) moved the deal on since we
      // read it. The edit was not recorded; the caller reloads and decides again against it.
      return jsonError(409, `deal ${id} changed while this edit was in flight; reload and try again`);
    }
    return jsonError(500, `deal edit failed: ${(err as Error).message}`);
  }
}
