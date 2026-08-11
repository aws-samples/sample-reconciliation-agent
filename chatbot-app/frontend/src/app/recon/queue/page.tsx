"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listCases, bulkUpdateCases, type ReconCase } from "@/lib/reconApi";
import { getStoredAccessToken } from "@/lib/reconToken";
import {
  ConfidenceMeter,
  Eyebrow,
  Panel,
  Placeholder,
  StatusPill,
} from "@/components/recon/ui";

// "OPEN" = the live triage queue (PENDING/IN_PROGRESS/PROPOSED); every other option filters
// the full case history by one status; "ALL" shows everything.
const FILTERS = [
  "OPEN",
  "ALL",
  "PENDING",
  "IN_PROGRESS",
  "PROPOSED",
  "APPROVED",
  "REJECTED",
  "RESOLVED",
  "AUTO_CLEARED",
  "CLOSED_NO_ACTION",
  "AGED",
] as const;

function QueueContent() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("status");
  const [filter, setFilter] = useState<string>(
    initial && FILTERS.includes(initial as (typeof FILTERS)[number])
      ? initial
      : "OPEN",
  );
  const [search, setSearch] = useState("");
  const [cases, setCases] = useState<ReconCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = (f: string) => {
    setCases(null);
    const opts =
      f === "OPEN"
        ? undefined
        : f === "ALL"
          ? { scope: "all" as const }
          : { status: f };
    return listCases(getStoredAccessToken(), opts)
      .then(setCases)
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const changeFilter = (f: string) => {
    setFilter(f);
    setSelected(new Set());
    router.replace(f === "OPEN" ? "/recon/queue" : `/recon/queue?status=${f}`);
  };

  const shown = (cases ?? []).filter(
    (c) =>
      !search.trim() ||
      c.item_id.toLowerCase().includes(search.trim().toLowerCase()) ||
      (c.class_id ?? "").toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === shown.length
        ? new Set()
        : new Set(shown.map((c) => c.item_id)),
    );
  };

  const applyBulk = async (status: "IN_PROGRESS" | "CLOSED_NO_ACTION") => {
    setBusy(status);
    setMsg(null);
    try {
      const res = await bulkUpdateCases(
        [...selected],
        status,
        comment.trim() || undefined,
      );
      setMsg(
        `Updated ${res.updated.length} case${res.updated.length === 1 ? "" : "s"}` +
          (res.failed.length ? ` · ${res.failed.length} failed` : ""),
      );
      setSelected(new Set());
      setComment("");
      await load(filter);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const selCount = selected.size;
  const isHistory = filter !== "OPEN";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Triage · Investigate · Resolve</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            {isHistory ? "Case History" : "Exception Queue"}
          </h1>
        </div>
        {cases && (
          <span className="rc-mono rc-tnum text-[13px] text-[var(--rc-ink-dim)]">
            {shown.length} {isHistory ? "item(s)" : "open"}
          </span>
        )}
      </header>

      {/* filter bar: status pills + free-text search over item id / class */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => changeFilter(f)}
            className="rc-mono rounded px-3 py-1 text-[11px] tracking-[0.06em]"
            style={{
              color: f === filter ? "var(--rc-ink)" : "var(--rc-ink-faint)",
              background: f === filter ? "var(--rc-panel-2)" : "transparent",
              border:
                f === filter
                  ? "1px solid var(--rc-cyan)"
                  : "1px solid var(--rc-line)",
            }}
          >
            {f}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item / class…"
          className="rc-mono ml-auto min-w-[220px] rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-1.5 text-[12px] text-[var(--rc-ink)]"
        />
      </div>

      {/* Bulk action bar — appears when items are selected. */}
      {selCount > 0 && (
        <Panel className="rc-rise flex flex-wrap items-center gap-3 p-4">
          <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
            {selCount} selected
          </span>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment (captured as a lesson)…"
            className="rc-mono min-w-[240px] flex-1 rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-2 text-[12px] text-[var(--rc-ink)]"
          />
          <button
            onClick={() => applyBulk("IN_PROGRESS")}
            disabled={busy !== null}
            className="rc-mono rounded border border-[var(--rc-violet)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-violet)] hover:bg-[var(--rc-violet)] hover:text-[#0a0410] disabled:opacity-40"
          >
            {busy === "IN_PROGRESS" ? "Updating…" : "Set In Progress"}
          </button>
          <button
            onClick={() => applyBulk("CLOSED_NO_ACTION")}
            disabled={busy !== null}
            className="rc-mono rounded border border-[var(--rc-ink-faint)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)] disabled:opacity-40"
          >
            {busy === "CLOSED_NO_ACTION" ? "Closing…" : "Close — no action"}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            disabled={busy !== null}
            className="rc-mono px-2 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
          >
            Clear
          </button>
        </Panel>
      )}

      {msg && (
        <p className="rc-mono text-[12px] text-[var(--rc-cyan)]">{msg}</p>
      )}

      {error ? (
        <Placeholder kind="error">Failed to load — {error}</Placeholder>
      ) : !cases ? (
        <Placeholder kind="loading">◆ fetching cases…</Placeholder>
      ) : shown.length === 0 ? (
        <Placeholder kind="empty">
          {isHistory
            ? "◇ no items match this filter"
            : "◇ queue clear — no open exceptions"}
        </Placeholder>
      ) : (
        <Panel className="rc-rise overflow-hidden">
          {/* header row */}
          <div className="grid grid-cols-[auto_1.4fr_1fr_1fr_1.6fr_auto] items-center gap-4 border-b border-[var(--rc-line)] px-5 py-3">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={selCount > 0 && selCount === shown.length}
              onChange={toggleAll}
              className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
            />
            {["Item", "Status", "Class", "Confidence", ""].map((h) => (
              <div key={h} className="rc-eyebrow">
                {h}
              </div>
            ))}
          </div>
          {shown.map((c) => (
            <div
              key={c.item_id}
              className="rc-row grid grid-cols-[auto_1.4fr_1fr_1fr_1.6fr_auto] items-center gap-4 border-b border-[var(--rc-line-soft)] px-5 py-4 last:border-0"
            >
              <input
                type="checkbox"
                aria-label={`Select ${c.item_id}`}
                checked={selected.has(c.item_id)}
                onChange={() => toggle(c.item_id)}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
              />
              <button
                onClick={() =>
                  router.push(`/recon/case/${encodeURIComponent(c.item_id)}`)
                }
                className="rc-mono cursor-pointer text-left text-[13px] text-[var(--rc-ink)] hover:text-[var(--rc-cyan)]"
              >
                {c.item_id}
              </button>
              <div>
                <StatusPill status={c.status} />
              </div>
              <div className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
                {c.class_id ??
                  (c.item?.attributes?.idp_class ? (
                    <span title="IDP document class (agent has not classified yet)">
                      {String(c.item.attributes.idp_class)}
                      <span className="text-[var(--rc-ink-faint)]"> · idp</span>
                    </span>
                  ) : (
                    "—"
                  ))}
              </div>
              <div>
                {c.confidence ? (
                  <ConfidenceMeter value={c.confidence} />
                ) : (
                  <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
                    —
                  </span>
                )}
              </div>
              <button
                onClick={() =>
                  router.push(`/recon/case/${encodeURIComponent(c.item_id)}`)
                }
                className="rc-mono text-[16px] text-[var(--rc-ink-faint)] hover:text-[var(--rc-cyan)]"
              >
                →
              </button>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

export default function QueuePage() {
  return (
    <Suspense
      fallback={<Placeholder kind="loading">◆ loading queue…</Placeholder>}
    >
      <QueueContent />
    </Suspense>
  );
}
