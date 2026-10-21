/**
 * Reading a deal's field overrides (design §4), for the review screens and the BFF alike.
 *
 * An override is one reviewer's change to one field with the reason they gave. The list on the deal
 * is append-only, so the latest entry for a field is the one that explains its current value; the
 * earlier ones stay as the field's audit trail.
 */

import type { DealRecord, FieldOverride } from "@/lib/pipeline/types";
import { overrideOrders } from "@/lib/pipeline/orders";

/**
 * Ceiling on one override reason, in characters. A reason becomes part of a memory event, and a
 * paragraph is plenty to say why a value is wrong; past this a client is pasting something else.
 */
export const MAX_OVERRIDE_REASON_CHARS = 2000;

/** A deal's overrides, oldest first; `[]` for deals staged before overrides existed. */
export function overridesOf(deal: Pick<DealRecord, "overrides">): FieldOverride[] {
  return deal.overrides ?? [];
}

/**
 * The override that explains each field's current value in one order, keyed by field key.
 *
 * @param orderIndex the order to read (0, the only one, on a single-order deal).
 */
export function latestOverrides(
  deal: Pick<DealRecord, "overrides">,
  orderIndex: number = 0,
): Record<string, FieldOverride> {
  const out: Record<string, FieldOverride> = {};
  for (const o of overridesOf(deal)) {
    if (overrideOrders(o).includes(orderIndex)) out[o.field] = o;
  }
  return out;
}
