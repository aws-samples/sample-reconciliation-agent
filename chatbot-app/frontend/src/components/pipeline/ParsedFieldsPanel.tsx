"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  DealRecord,
  EmailRecord,
  FieldEvidence,
  FieldOverride,
  OmsFieldDef,
} from "@/lib/pipeline/types";
import { fieldsBySection } from "@/lib/pipeline/omsSchema";
import { latestOverrides } from "@/lib/pipeline/overrides";
import { orderName, ordersOf, parsedOrdersOf, sharedKeys } from "@/lib/pipeline/orders";
import { formatDuration } from "@/components/pipeline/format";
import {
  BTN_LINK,
  BTN_PRIMARY,
  BTN_QUIET,
  Disclosure,
  Eyebrow,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";
import { OverrideEditor, OverrideNote } from "@/components/pipeline/OverrideEditor";
import { OrderStrip } from "@/components/pipeline/OrderStrip";
import { ConfidenceChip, StatusPill } from "@/components/pipeline/ui";

// What the parsing agent made of the email, beside the email itself. Every value is shown with the
// text it came from and the rule that shaped it, because "the parser said S+275 means 2.750%" is
// only reviewable when the reviewer can see the line that said S+275 and the skill that said how to
// convert it.
//
// Once the parse has staged a deal, the panel shows the deal's CURRENT values — the parser's, or a
// reviewer's override — and, while the deal is still open, lets the reviewer override any of them in
// place with a reason. The email stays visible beside the editor, which is the point of editing here
// rather than on the deal page: the reason is usually a quote from the email.
//
// An email that offers several instruments stages one deal with several orders (design §15). The
// panel then shows one order at a time, picked from a strip of chips, with its fields split into
// "shared by all orders" (equal in every order, computed rather than declared by the parser) and
// "this order". Overriding a shared field asks whether the correction applies to every order —
// one override, one lesson — or to this one alone.

/** A small labelled chip, for skills, memory hits and enriched fields. */
function Chip({ children, title }: { children: string; title?: string }) {
  return (
    <span
      className="rc-mono rounded border border-[var(--rc-line)] px-2 py-0.5 text-[10.5px] text-[var(--rc-ink-dim)]"
      title={title}
    >
      {children}
    </span>
  );
}

/** The parsed value with the evidence behind it as a disclosure body. */
function EvidenceBody({ evidence }: { evidence: FieldEvidence }) {
  return (
    <div className="space-y-2 p-3">
      {evidence.excerpt ? (
        <blockquote className="rc-mono whitespace-pre-wrap border-l-2 border-[var(--rc-cyan)] pl-3 text-[11.5px] leading-relaxed text-[var(--rc-ink-dim)]">
          {evidence.excerpt}
        </blockquote>
      ) : (
        <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          no excerpt — the value was inferred rather than read
        </p>
      )}
      {evidence.rule && (
        <p className="text-[12px] leading-relaxed text-[var(--rc-ink)]">
          <span className="rc-eyebrow mr-2">rule</span>
          {evidence.rule}
        </p>
      )}
    </div>
  );
}

/**
 * One parsed field: label, value, confidence; opens to the excerpt and rule when there is evidence.
 * With `onEdit`, a ✎ opens the override editor under the row; `override` explains a changed value.
 */
function FieldRow({
  def,
  value,
  evidence,
  override,
  onEdit,
  onRetract,
  editor,
}: {
  def: OmsFieldDef;
  value: string;
  evidence: FieldEvidence | undefined;
  override?: FieldOverride;
  onRetract?: (o: FieldOverride) => Promise<void>;
  onEdit?: () => void;
  /** The open override editor for this row, when it is the one being edited. */
  editor?: ReactNode;
}) {
  const summary = (
    <span className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-baseline gap-3">
      <span className="rc-mono truncate text-[11px] text-[var(--rc-ink-faint)]" title={def.key}>
        {def.label}
      </span>
      <span
        className="rc-mono break-words text-[12px]"
        style={{ color: value ? "var(--rc-ink)" : "var(--rc-ink-faint)" }}
        data-field={def.key}
      >
        {value || "—"}
      </span>
    </span>
  );
  const row = !evidence ? (
    <div className="rounded border border-[var(--rc-line-soft)] px-3 py-2">{summary}</div>
  ) : (
    <Disclosure summary={summary} meta={<ConfidenceChip level={evidence.confidence} />}>
      <EvidenceBody evidence={evidence} />
    </Disclosure>
  );
  return (
    <div>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">{row}</div>
        {onEdit && (
          // Beside the row, not inside it: the evidence row is itself a button, and a button inside
          // a button is neither valid nor reachable by keyboard.
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Override ${def.label}`}
            title={`Override ${def.label}`}
            className="rc-mono mt-1 rounded px-1.5 py-1 text-[13px] leading-none text-[var(--rc-ink-faint)] hover:bg-[var(--rc-panel-2)] hover:text-[var(--rc-violet)]"
          >
            ✎
          </button>
        )}
      </div>
      {override && !editor && <OverrideNote override={override} onRetract={onRetract} />}
      {editor}
    </div>
  );
}

export function ParsedFieldsPanel({
  email,
  deal = null,
  onOverride,
  onRetract,
  onReparse,
  reparsing = false,
}: {
  email: EmailRecord;
  /** The deal this parse staged. When given, its current values and overrides are shown. */
  deal?: DealRecord | null;
  /**
   * Present while the deal can still be edited; saves one field's override with its reason, for
   * the given orders (`[0]` on a single-order deal).
   */
  onOverride?: (key: string, value: string, reason: string, orders: number[]) => Promise<void>;
  /**
   * For each override, the retract action when the viewer may take its lesson back (its author or an
   * admin), else undefined. Independent of `onOverride`: a lesson from a finished deal can still be
   * wrong.
   */
  onRetract?: (override: FieldOverride) => ((o: FieldOverride) => Promise<void>) | undefined;
  onReparse?: () => void;
  reparsing?: boolean;
}) {
  // Blank fields hidden by default: the schema has seventy columns and most of an email fills
  // twenty. The count of what is hidden is shown, so "hidden" never reads as "missing".
  const [showBlank, setShowBlank] = useState(false);
  // One editor at a time: two half-written reasons on one screen is one too many to keep track of.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [orderIndex, setOrderIndex] = useState(0);
  const parse = email.parse;
  const inFlight = email.status === "RECEIVED" || email.status === "PARSING";
  const orders = deal ? ordersOf(deal) : parse ? parsedOrdersOf(parse) : [];
  const multi = orders.length > 1;
  const sel = Math.min(orderIndex, Math.max(orders.length - 1, 0));
  const order = orders[sel];
  const values = order?.fields ?? {};
  const evidence = order?.evidence ?? {};
  const parsedValues = deal ? ordersOf(deal)[sel]?.original_fields : order?.fields;
  const assumptions = order?.assumptions ?? parse?.assumptions ?? [];
  const latest = deal ? latestOverrides(deal, sel) : {};
  const shared = multi ? sharedKeys(orders) : null;

  /** The OMS sections, restricted to the keys `inGroup` admits; `null` when nothing shows. */
  const sections = (inGroup: (key: string) => boolean) => {
    const out = fieldsBySection().map(({ section, fields: all }) => {
      const fields = all.filter((f) => inGroup(f.key));
      if (fields.length === 0) return null;
      const rows = fields.filter(
        (f) =>
          showBlank ||
          (values[f.key] ?? "") !== "" ||
          evidence[f.key] ||
          latest[f.key] ||
          editingKey === f.key,
      );
      const hidden = fields.length - rows.length;
      if (rows.length === 0 && !showBlank) return null;
      return (
        <section key={section}>
          <div className="flex items-baseline justify-between">
            <Eyebrow>{section}</Eyebrow>
            {hidden > 0 && (
              <span className="rc-mono text-[10.5px] text-[var(--rc-ink-faint)]">
                {hidden} blank hidden
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1.5">
            {rows.map((f) => {
              const sharedBy = shared?.has(f.key) ? orders.length : undefined;
              return (
                <FieldRow
                  key={f.key}
                  def={f}
                  value={values[f.key] ?? ""}
                  evidence={evidence[f.key]}
                  override={latest[f.key]}
                  onRetract={latest[f.key] ? onRetract?.(latest[f.key]) : undefined}
                  onEdit={
                    onOverride ? () => setEditingKey((k) => (k === f.key ? null : f.key)) : undefined
                  }
                  editor={
                    onOverride && editingKey === f.key ? (
                      <OverrideEditor
                        def={f}
                        current={values[f.key] ?? ""}
                        parsed={parsedValues?.[f.key] ?? ""}
                        sharedBy={sharedBy}
                        onSave={async (value, reason, allOrders) => {
                          await onOverride(
                            f.key,
                            value,
                            reason,
                            allOrders ? orders.map((_, i) => i) : [sel],
                          );
                          setEditingKey(null);
                        }}
                        onCancel={() => setEditingKey(null)}
                      />
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </section>
      );
    });
    return out.some(Boolean) ? out : null;
  };

  return (
    <Panel className="rc-rise p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Eyebrow>Parsed · agent output</Eyebrow>
          <StatusPill status={email.status} />
        </div>
        <div className="flex items-center gap-2">
          {email.deal_id && (
            <Link href={`/pipeline/deals/${encodeURIComponent(email.deal_id)}`} className={BTN_PRIMARY}>
              Open deal →
            </Link>
          )}
          {onReparse && (
            <button
              type="button"
              onClick={onReparse}
              disabled={reparsing || inFlight}
              className={BTN_QUIET}
              title="Run the parser again with the current skills and memory"
            >
              {reparsing ? "Re-parsing…" : "Re-parse"}
            </button>
          )}
        </div>
      </div>

      {inFlight ? (
        <div className="mt-4">
          <Placeholder kind="loading">
            ◆ {email.status === "RECEIVED" ? "queued for the parser…" : "the parsing agent is reading the email…"}
          </Placeholder>
        </div>
      ) : email.status === "PARSE_FAILED" ? (
        <div className="mt-4">
          <Placeholder kind="error">Parse failed — {email.error ?? "no reason recorded"}</Placeholder>
        </div>
      ) : !parse ? (
        <div className="mt-4">
          <Placeholder kind="empty">◇ parsed, but no output was stored</Placeholder>
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {/* Run metadata: which model, how long, which skills and memories shaped the result. */}
          <dl className="rc-mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
            <dt className="rc-eyebrow pt-0.5">Model</dt>
            <dd className="break-all text-[var(--rc-ink)]">{parse.model_id || "—"}</dd>
            <dt className="rc-eyebrow pt-0.5">Duration</dt>
            <dd className="text-[var(--rc-ink)]">{formatDuration(parse.duration_ms)}</dd>
            <dt className="rc-eyebrow pt-0.5">Skills</dt>
            <dd className="flex flex-wrap gap-1.5">
              {parse.skills_used.length === 0 ? (
                <span className="text-[var(--rc-ink-faint)]">none loaded</span>
              ) : (
                parse.skills_used.map((s) => <Chip key={s}>{s}</Chip>)
              )}
            </dd>
            <dt className="rc-eyebrow pt-0.5">Memory</dt>
            <dd className="flex flex-wrap gap-1.5" data-testid="memory-hits">
              {parse.memory_hits.length === 0 ? (
                <span className="text-[var(--rc-ink-faint)]">no relevant memories recalled</span>
              ) : (
                parse.memory_hits.map((m, i) => (
                  <Chip key={m.record_id ?? i} title={m.text}>
                    {m.text.length > 72 ? `${m.text.slice(0, 72)}…` : m.text}
                  </Chip>
                ))
              )}
            </dd>
            <dt className="rc-eyebrow pt-0.5">Enrichment</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {parse.enrichment.issuer_match ? (
                <>
                  <span className="text-[var(--rc-ink)]">
                    security master → {parse.enrichment.issuer_match}
                  </span>
                  {parse.enrichment.fields_from_security_master.map((k) => (
                    <Chip key={k} title="filled from the security master">
                      {k}
                    </Chip>
                  ))}
                </>
              ) : (
                <span className="text-[var(--rc-ink-faint)]">no issuer match in the security master</span>
              )}
            </dd>
          </dl>

          {deal && !onOverride && (
            <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
              Values are read-only: the deal is {deal.status.toLowerCase().replace(/_/g, " ")}.
            </p>
          )}

          {multi && (
            <OrderStrip
              orders={orders}
              selected={sel}
              deal={deal}
              onSelect={(i) => {
                setOrderIndex(i);
                setEditingKey(null);
              }}
            />
          )}

          {/* The fields, by OMS section — split into shared and per-order when there are orders. */}
          <div className="space-y-4">
            {multi ? (
              <>
                <div className="space-y-4" data-group="shared">
                  <h3 className="rc-mono text-[11px] uppercase tracking-[0.14em] text-[var(--rc-cyan)]">
                    Shared by all {orders.length} orders
                  </h3>
                  {sections((k) => shared!.has(k)) ?? (
                    <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">◇ nothing shared</p>
                  )}
                </div>
                <div className="space-y-4" data-group="order">
                  <h3 className="rc-mono text-[11px] uppercase tracking-[0.14em] text-[var(--rc-cyan)]">
                    This order · {sel + 1} · {orderName(orders, sel)}
                  </h3>
                  {sections((k) => !shared!.has(k)) ?? (
                    <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">◇ no value differs from the other orders</p>
                  )}
                </div>
              </>
            ) : (
              sections(() => true)
            )}
            <button type="button" onClick={() => setShowBlank((v) => !v)} className={BTN_LINK}>
              {showBlank ? "Hide blank fields" : "Show blank fields"}
            </button>
          </div>

          {/* What the agent decided without direct evidence — the list a reviewer reads first. */}
          <section>
            <Eyebrow>Assumptions{multi ? ` · ${orderName(orders, sel)}` : ""}</Eyebrow>
            {assumptions.length === 0 ? (
              <p className="rc-mono mt-2 text-[12px] text-[var(--rc-ink-faint)]">
                ◇ none recorded
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {assumptions.map((a, i) => (
                  <li
                    key={i}
                    className="border-l-2 border-[var(--rc-amber)] pl-3 text-[12.5px] leading-relaxed text-[var(--rc-ink)]"
                  >
                    {a}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
