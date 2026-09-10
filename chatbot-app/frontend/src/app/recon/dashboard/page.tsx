"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listCases, type ReconCase } from "@/lib/reconApi";
import {
  ConfidenceMeter,
  Eyebrow,
  Panel,
  Placeholder,
  Stat,
} from "@/components/recon/ui";

// Every lifecycle status, in flow order. Each tile drills into the filtered history view.
const LIFECYCLE: {
  status: string;
  label: string;
  color: string;
  terminal?: boolean;
}[] = [
  { status: "PENDING", label: "Pending Triage", color: "var(--rc-amber)" },
  {
    status: "IN_PROGRESS",
    label: "In Investigation",
    color: "var(--rc-violet)",
  },
  // Not terminal: a FAILED case is retryable, and its tile is a work queue, not an archive.
  { status: "FAILED", label: "Failed — Retry", color: "var(--rc-red)" },
  { status: "PROPOSED", label: "Awaiting Approval", color: "var(--rc-cyan)" },
  { status: "APPROVED", label: "Approved", color: "var(--rc-green)" },
  { status: "REJECTED", label: "Rejected", color: "var(--rc-red)" },
  {
    status: "AUTO_CLEARED",
    label: "Auto-Cleared (Tier-1)",
    color: "var(--rc-green)",
    terminal: true,
  },
  {
    status: "RESOLVED",
    label: "Resolved",
    color: "var(--rc-green)",
    terminal: true,
  },
  {
    status: "CLOSED_NO_ACTION",
    label: "Closed — No Action",
    color: "var(--rc-ink-dim)",
    terminal: true,
  },
  { status: "AGED", label: "Aged Out", color: "var(--rc-red)", terminal: true },
];
const OPEN = new Set(["PENDING", "IN_PROGRESS", "PROPOSED", "FAILED"]);

export default function DashboardPage() {
  const [cases, setCases] = useState<ReconCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Full history — the dashboard reflects every status, not just the open queue.
    listCases({ scope: "all" })
      .then(setCases)
      .catch((e) => setError(String(e)));
  }, []);

  if (error)
    return (
      <Placeholder kind="error">Failed to load dashboard — {error}</Placeholder>
    );
  if (!cases)
    return (
      <Placeholder kind="loading">◆ loading reconciliation state…</Placeholder>
    );

  const byStatus = cases.reduce<Record<string, number>>((a, c) => {
    a[c.status] = (a[c.status] ?? 0) + 1;
    return a;
  }, {});
  const openCount = cases.filter((c) => OPEN.has(c.status)).length;
  const proposed = cases.filter((c) => c.status === "PROPOSED");
  const avgConf =
    proposed.length > 0
      ? proposed.reduce(
          (s, c) => s + (parseFloat(c.confidence ?? "0") || 0),
          0,
        ) / proposed.length
      : 0;
  const autoRate =
    cases.length > 0
      ? ((byStatus["AUTO_CLEARED"] ?? 0) + (byStatus["RESOLVED"] ?? 0)) /
        cases.length
      : 0;
  const total = cases.length || 1;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Operations Console</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            Reconciliation Overview
          </h1>
        </div>
        <Link
          href="/recon/queue"
          className="rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-cyan)] transition-colors hover:bg-[var(--rc-cyan)] hover:text-[#04120f]"
        >
          Open Queue →
        </Link>
      </header>

      {/* headline stats */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total Items (History)" value={cases.length} delay={0} />
        <Stat
          label="Open Cases"
          value={openCount}
          accent="var(--rc-amber)"
          delay={60}
        />
        <Stat
          label="Awaiting Approval"
          value={byStatus["PROPOSED"] ?? 0}
          accent="var(--rc-cyan)"
          delay={120}
        />
        <Stat
          label="Straight-Through"
          value={byStatus["AUTO_CLEARED"] ?? 0}
          accent="var(--rc-green)"
          delay={180}
        />
      </section>

      {/* full lifecycle — every status is a drill-down into the filtered history */}
      <section>
        <Eyebrow>Lifecycle · click a status to drill down</Eyebrow>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {LIFECYCLE.map((s) => (
            <Link
              key={s.status}
              href={`/recon/queue?status=${s.status}`}
              className="rc-rise group rounded border border-[var(--rc-line)] bg-[var(--rc-panel)] p-3 transition-colors hover:border-[var(--rc-cyan)]"
              title={`Show all ${s.status} items`}
            >
              <div
                className="rc-mono text-[10px] uppercase tracking-[0.08em]"
                style={{ color: s.color }}
              >
                {s.label}
              </div>
              <div className="rc-display rc-tnum mt-1 text-[24px] font-bold text-[var(--rc-ink)] group-hover:text-[var(--rc-cyan)]">
                {byStatus[s.status] ?? 0}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="rc-rise p-6 lg:col-span-2" scan>
          <Eyebrow>Composition (all history)</Eyebrow>
          <div className="mt-5 flex h-3 w-full overflow-hidden rounded-full bg-[var(--rc-line)]">
            {LIFECYCLE.filter((s) => byStatus[s.status]).map((s) => (
              <div
                key={s.status}
                title={`${s.status}: ${byStatus[s.status]}`}
                style={{
                  width: `${((byStatus[s.status] ?? 0) / total) * 100}%`,
                  background: s.color,
                }}
              />
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
            {LIFECYCLE.filter((s) => byStatus[s.status]).map((s) => (
              <Link
                key={s.status}
                href={`/recon/queue?status=${s.status}`}
                className="flex items-center gap-2 hover:opacity-80"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: s.color }}
                />
                <span className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">
                  {s.status}
                </span>
                <span className="rc-mono rc-tnum text-[12px] text-[var(--rc-ink)]">
                  {byStatus[s.status]}
                </span>
              </Link>
            ))}
            {cases.length === 0 && (
              <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
                no items yet
              </span>
            )}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel className="rc-rise p-6">
            {/* "Evidence Score" everywhere, matching the case screen. "Proposal Confidence" would
                read as a number the model reported about itself; no such number exists anywhere in
                the system, and this one is computed evidence completeness. */}
            <Eyebrow>Mean Evidence Score</Eyebrow>
            <div className="mt-4">
              <ConfidenceMeter value={avgConf} />
            </div>
            <p className="rc-mono mt-3 text-[11px] leading-relaxed text-[var(--rc-ink-faint)]">
              Computed evidence completeness across {proposed.length} case
              {proposed.length === 1 ? "" : "s"} awaiting approval.
            </p>
          </Panel>
          <Panel className="rc-rise p-6">
            <Eyebrow>Straight-Through Rate</Eyebrow>
            <div className="rc-display rc-tnum mt-3 text-[28px] font-bold text-[var(--rc-green)]">
              {(autoRate * 100).toFixed(0)}%
            </div>
            <p className="rc-mono mt-2 text-[11px] leading-relaxed text-[var(--rc-ink-faint)]">
              Auto-cleared (Tier-1) + resolved, over all history.
            </p>
          </Panel>
        </div>
      </section>
    </div>
  );
}
