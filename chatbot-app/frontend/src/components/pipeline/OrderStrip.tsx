"use client";

import type { DealRecord } from "@/lib/pipeline/types";
import { overridesOf } from "@/lib/pipeline/overrides";
import { orderName, overrideOrders } from "@/lib/pipeline/orders";

// The orders of a deal that stages several (design §15), as a row of chips: pick one to see and
// edit its values. Each chip says how many overrides changed that order and, after a rejected
// upload, how many of the OMS's errors were in its row — the two things that send a reviewer to
// one order rather than another.

export function OrderStrip({
  orders,
  selected,
  onSelect,
  deal = null,
}: {
  orders: { label: string }[];
  selected: number;
  onSelect: (index: number) => void;
  /** For the per-order override and upload-error counts; absent before a deal is staged. */
  deal?: DealRecord | null;
}) {
  const overrides = deal ? overridesOf(deal) : [];
  const errors = deal?.upload && !deal.upload.accepted ? deal.upload.errors : [];
  return (
    <div className="space-y-2">
      <p className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">
        {orders.length} orders from this email — one row each in the staging file
      </p>
      <div role="group" aria-label="Orders" className="flex flex-wrap gap-1.5">
        {orders.map((o, i) => {
          const edits = overrides.filter((ov) => overrideOrders(ov).includes(i)).length;
          const broken = errors.filter((e) => e.row === i).length;
          const active = i === selected;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={active}
              data-order={i}
              className="rc-mono flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11.5px]"
              style={{
                borderColor: active ? "var(--rc-cyan)" : "var(--rc-line)",
                color: active ? "var(--rc-ink)" : "var(--rc-ink-dim)",
              }}
            >
              <span>
                {i + 1} · {orderName(orders, i)}
              </span>
              {edits > 0 && (
                <span style={{ color: "var(--rc-violet)" }} title={`${edits} override(s)`}>
                  ✎{edits}
                </span>
              )}
              {broken > 0 && (
                <span style={{ color: "var(--rc-red)" }} title={`${broken} OMS error(s) in this row`}>
                  ✕{broken}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
