// @vitest-environment node
/**
 * A deal's orders (design §15): one deal per email, one order per instrument, one CSV row each.
 *
 * Pinned: a single-order deal reads as one order made of its own fields and is written back
 * without ever gaining `orders`; a multi-order write keeps the top-level fields the first order's;
 * "shared" means equal in every order; and an override's orders default to the first.
 */
import { describe, expect, it } from "vitest";

import { emptyFields } from "@/lib/pipeline/omsSchema";
import {
  dealRows,
  isMultiOrder,
  orderName,
  ordersOf,
  overrideOrders,
  parsedOrdersOf,
  sharedKeys,
  withOrderValues,
} from "@/lib/pipeline/orders";
import { latestOverrides } from "@/lib/pipeline/overrides";
import type { DealRecord, FieldOverride, ParseOutput } from "@/lib/pipeline/types";

const usd = { ...emptyFields(), opportunity_name: "Bluehaven 2L notes", currency: "USD", left_agent: "Harbor Point" };
const eur = { ...usd, currency: "EUR" };

function deal(over: Partial<DealRecord> = {}): DealRecord {
  return {
    deal_id: "dl_1",
    email_id: "em_1",
    opportunity_name: usd.opportunity_name,
    status: "STAGED",
    fields: usd,
    original_fields: usd,
    evidence: {},
    assumptions: ["shared"],
    memory_hits: [],
    skills_used: [],
    enrichment: { issuer_match: null, fields_from_security_master: [] },
    csv_key: "deal-csv/dl_1.csv",
    upload: null,
    history: [],
    created_at: "t",
    updated_at: "t",
    ...over,
  };
}

const twoOrders = () =>
  deal({
    orders: [
      { label: "USD 5yr", fields: usd, original_fields: usd, evidence: {} },
      { label: "", fields: eur, original_fields: eur, evidence: {} },
    ],
  });

describe("orders", () => {
  it("reads a single-order deal as one order of its own fields, and a parse the same way", () => {
    const one = ordersOf(deal());
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ label: "", fields: usd, original_fields: usd, assumptions: ["shared"] });
    expect(isMultiOrder(deal())).toBe(false);
    expect(dealRows(deal())).toEqual([usd]);

    const parse = { fields: usd, evidence: {}, assumptions: ["a"] } as unknown as ParseOutput;
    expect(parsedOrdersOf(parse)).toEqual([{ label: "", fields: usd, evidence: {}, assumptions: ["a"] }]);
  });

  it("calls a value shared only when every order holds it, and names unlabelled orders", () => {
    const d = twoOrders();
    const shared = sharedKeys(ordersOf(d));
    expect(shared.has("left_agent")).toBe(true);
    expect(shared.has("currency")).toBe(false);
    expect(sharedKeys([{ fields: usd }]).has("currency")).toBe(true); // one order: everything shared
    expect(orderName(ordersOf(d), 0)).toBe("USD 5yr");
    expect(orderName(ordersOf(d), 1)).toBe("order 2");
    expect(orderName(ordersOf(deal()), 0)).toBe("");
    expect(dealRows(d)).toEqual([usd, eur]);
  });

  it("writes new values to some orders and keeps the top level the first order's", () => {
    const d = twoOrders();
    const renamed = { ...usd, opportunity_name: "Bluehaven second-lien notes" };
    const next = withOrderValues(d, new Map([[0, renamed]]));
    expect(next.orders![0].fields).toEqual(renamed);
    expect(next.orders![1].fields).toEqual(eur); // untouched
    expect(next.fields).toEqual(renamed);
    expect(next.opportunity_name).toBe("Bluehaven second-lien notes");

    // A single-order deal never gains `orders`.
    const single = withOrderValues(deal(), new Map([[0, renamed]]));
    expect("orders" in single).toBe(false);
    expect(single.fields).toEqual(renamed);
  });

  it("reads an override's orders as the first by default, and finds each order's latest override", () => {
    const base = { field: "left_agent", reason: "r", actor: "a", at: "t", stage: "review", memory: { status: "sent" } };
    const all = { ...base, override_id: "ov_all", order_indexes: [0, 1] } as FieldOverride;
    const second = { ...base, override_id: "ov_second", order_indexes: [1] } as FieldOverride;
    const legacy = { ...base, override_id: "ov_legacy" } as FieldOverride;
    expect(overrideOrders(legacy)).toEqual([0]);
    const d = deal({ overrides: [all, second] });
    expect(latestOverrides(d, 0).left_agent.override_id).toBe("ov_all");
    expect(latestOverrides(d, 1).left_agent.override_id).toBe("ov_second");
    expect(latestOverrides(deal({ overrides: [legacy] })).left_agent.override_id).toBe("ov_legacy");
  });
});
