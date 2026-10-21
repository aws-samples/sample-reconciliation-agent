/**
 * Reading and changing a deal's orders (design §15), for the review screens and the BFF alike.
 *
 * One deal per email, one order per instrument it offers, one row per order in the deal's staging
 * file. Most deals have one order and carry no `orders` at all; every reader goes through
 * `ordersOf`, which presents such a deal as one order made of its own fields, so single- and
 * multi-order deals are handled by one code path. Writers go through `withOrderValues`, which keeps
 * the top-level fields the first order's — the mirror older readers rely on.
 */

import type {
  DealOrder,
  DealRecord,
  FieldOverride,
  FieldValues,
  ParsedOrder,
  ParseOutput,
} from "@/lib/pipeline/types";
import { OMS_FIELDS } from "@/lib/pipeline/omsSchema";

/** A deal's orders, first to last; a single-order deal is one order made of its own fields. */
export function ordersOf(
  deal: Pick<DealRecord, "orders" | "fields" | "original_fields" | "evidence" | "assumptions">,
): DealOrder[] {
  if (deal.orders && deal.orders.length > 0) return deal.orders;
  return [
    {
      label: "",
      fields: deal.fields,
      original_fields: deal.original_fields,
      evidence: deal.evidence,
      assumptions: deal.assumptions,
    },
  ];
}

/** A parse's orders; a single-order parse is one order made of its own fields. */
export function parsedOrdersOf(parse: ParseOutput): ParsedOrder[] {
  if (parse.orders && parse.orders.length > 0) return parse.orders;
  return [{ label: "", fields: parse.fields, evidence: parse.evidence, assumptions: parse.assumptions }];
}

/** Whether the deal stages more than one order. */
export function isMultiOrder(deal: Pick<DealRecord, "orders">): boolean {
  return (deal.orders?.length ?? 0) > 1;
}

/** The deal's staging-file rows, one per order. */
export function dealRows(deal: DealRecord): FieldValues[] {
  return ordersOf(deal).map((o) => o.fields);
}

/** The orders an override changed; `[0]` for an override on a single-order deal. */
export function overrideOrders(override: Pick<FieldOverride, "order_indexes">): number[] {
  return override.order_indexes ?? [0];
}

/**
 * Field keys whose value is the same in every order — what the panel lists as "shared by all
 * orders". Every key when there is one order.
 */
export function sharedKeys(orders: { fields: FieldValues }[]): Set<string> {
  const out = new Set<string>();
  for (const f of OMS_FIELDS) {
    const first = orders[0]?.fields[f.key] ?? "";
    if (orders.every((o) => (o.fields[f.key] ?? "") === first)) out.add(f.key);
  }
  return out;
}

/** "USD 5yr", or "order 2" for an order the parser left unlabelled, or "" on a single-order deal. */
export function orderName(orders: { label: string }[], index: number): string {
  if (orders.length <= 1) return "";
  return orders[index]?.label || `order ${index + 1}`;
}

/**
 * The deal with new field values on the given orders — pure; the caller persists it.
 *
 * Keeps the top-level `fields` (and the denormalised opportunity name) the first order's. A
 * single-order deal stays without `orders`, exactly as it was staged.
 *
 * @param fieldsFor the complete new field set for each order index being changed.
 */
export function withOrderValues(deal: DealRecord, fieldsFor: Map<number, FieldValues>): DealRecord {
  const orders = ordersOf(deal).map((o, i) => (fieldsFor.has(i) ? { ...o, fields: fieldsFor.get(i)! } : o));
  const first = orders[0].fields;
  return {
    ...deal,
    fields: first,
    opportunity_name: first.opportunity_name || deal.opportunity_name,
    ...(isMultiOrder(deal) ? { orders } : {}),
  };
}
