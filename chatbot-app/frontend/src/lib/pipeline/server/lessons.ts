/**
 * The knowledge memory's lessons joined with the overrides that taught them (design §8).
 *
 * A record an override produced carries that override's id, author and deal as metadata (the
 * strategy copies them from the event; see `PROVENANCE_KEYS`). This module reads them back: listing
 * attaches the override's field, deal name and reason to each lesson, so the Memory Manager can say
 * who taught what and show two lessons about one field side by side; deleting marks the overrides
 * whose lessons went as retracted, so a deal never claims a lesson the parser no longer has.
 *
 * Both the Memory Manager's REST routes and the assistant's tools go through here, so a lesson
 * pruned from either place is pruned the same way.
 */

import type { DealRecord, LessonSource, MemoryRecord } from "@/lib/pipeline/types";
import { overridesOf } from "@/lib/pipeline/overrides";
import { getDeal, listDeals, markLessonsRetracted } from "./dealStore";
import {
  batchDelete,
  EDGE_CASES_NAMESPACE,
  listRecords,
  PROVENANCE_KEYS,
  type BatchDeleteOutcome,
} from "./memoryClient";

/** The override provenance a record carries, or null for a rule saved another way. */
function provenanceOf(record: MemoryRecord): { overrideId: string; author: string; dealId: string } | null {
  const m = record.metadata ?? {};
  const overrideId = m[PROVENANCE_KEYS.overrideId];
  const dealId = m[PROVENANCE_KEYS.dealId];
  if (!overrideId || !dealId) return null;
  return { overrideId, author: m[PROVENANCE_KEYS.author] ?? "", dealId };
}

/**
 * Attach each override lesson's `source`, read from the override on its deal.
 *
 * One scan of the deals table serves every record, which is the right trade at the sample's scale
 * (a desk's deals, not a firm's history). A deal or override that can no longer be read still gets
 * a source with the provenance the record itself carries.
 */
export async function withSources(records: MemoryRecord[]): Promise<MemoryRecord[]> {
  if (!records.some((r) => provenanceOf(r))) return records;
  const byOverride = new Map<string, { deal: DealRecord; field: string; reason: string; at: string }>();
  for (const deal of await listDeals()) {
    for (const o of overridesOf(deal)) {
      byOverride.set(o.override_id, { deal, field: o.field, reason: o.reason, at: o.at });
    }
  }
  return records.map((r) => {
    const p = provenanceOf(r);
    if (!p) return r;
    const found = byOverride.get(p.overrideId);
    const source: LessonSource = {
      kind: "override",
      override_id: p.overrideId,
      author: p.author,
      deal_id: p.dealId,
      ...(found
        ? {
            field: found.field,
            opportunity_name: found.deal.opportunity_name,
            reason: found.reason,
            at: found.at,
          }
        : {}),
    };
    return { ...r, source };
  });
}

/** Every lesson in the desk namespace, newest first, with its source when an override taught it. */
export async function listLessons(): Promise<MemoryRecord[]> {
  return withSources(await listRecords(EDGE_CASES_NAMESPACE));
}

/**
 * Delete lessons by record id, then mark the overrides they came from as retracted.
 *
 * The provenance is read before the delete, from one listing — afterwards the records are gone.
 * Marking the deals is best effort: the delete is the outcome that matters and has already
 * happened, so a deal that cannot be updated is reported, not rethrown.
 *
 * @returns the delete outcome plus `retracted` (override ids now marked) and `unmarked` (deals that
 *   could not be updated), or null when the knowledge memory is not configured.
 */
export async function deleteLessons(
  ids: string[],
  actor: string,
): Promise<(BatchDeleteOutcome & { retracted: string[]; unmarked: string[] }) | null> {
  const wanted = new Set(ids);
  const provenance = (await listRecords(EDGE_CASES_NAMESPACE))
    .filter((r) => wanted.has(r.id))
    .map((r) => ({ id: r.id, p: provenanceOf(r) }));
  const outcome = await batchDelete(ids);
  if (outcome === null) return null;

  const deleted = new Set(outcome.deleted);
  const perDeal = new Map<string, Record<string, number>>();
  for (const { id, p } of provenance) {
    if (!p || !deleted.has(id)) continue;
    const counts = perDeal.get(p.dealId) ?? {};
    counts[p.overrideId] = (counts[p.overrideId] ?? 0) + 1;
    perDeal.set(p.dealId, counts);
  }
  const retracted: string[] = [];
  const unmarked: string[] = [];
  for (const [dealId, counts] of perDeal) {
    try {
      const deal = await getDeal(dealId, { consistent: true });
      if (!deal) continue;
      // Only overrides still on the deal and not already marked: a second delete of a lesson
      // re-extracted from the same event must not add a second history row.
      const live = Object.fromEntries(
        Object.entries(counts).filter(([oid]) =>
          overridesOf(deal).some((o) => o.override_id === oid && o.memory.status !== "retracted"),
        ),
      );
      if (Object.keys(live).length === 0) continue;
      await markLessonsRetracted(deal, live, actor);
      retracted.push(...Object.keys(live));
    } catch {
      unmarked.push(dealId);
    }
  }
  return { ...outcome, retracted, unmarked };
}
