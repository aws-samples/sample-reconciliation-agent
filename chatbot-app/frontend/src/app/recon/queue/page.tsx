"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listCases, bulkUpdateCases, type ReconCase } from "@/lib/reconApi";
import { getStoredAccessToken } from "@/lib/reconToken";
import { NewItemModal } from "@/components/recon/NewItemModal";
import { DataTable, type DataTableColumn } from "@/components/recon/DataTable";
import { useReconSubject } from "@/hooks/useReconSubject";
import {
  ConfidenceMeter,
  Eyebrow,
  Panel,
  Placeholder,
  StatusPill,
} from "@/components/recon/ui";

// "OPEN" = the live triage queue (PENDING/IN_PROGRESS/PROPOSED/FAILED); every other option filters
// the full case history by one status; "ALL" shows everything. FAILED is listed right after
// IN_PROGRESS because that is the pair an analyst compares: still running vs. died and needs a retry.
const FILTERS = [
  "OPEN",
  "ALL",
  "PENDING",
  "IN_PROGRESS",
  "FAILED",
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
  // Empty on the first render. The table falls back to the shipped columns until it resolves, and only
  // then reads this person's stored layout — see `columnPrefs.ts` for why a placeholder is not an option.
  const { subject: sub } = useReconSubject();
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
  const [creating, setCreating] = useState(false);

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

  /**
   * The class shown for a case, and the provenance suffix that says where it came from.
   *
   * Three sources, most authoritative first: the agent's own `class_id`, then Tier-1's suggestion (a
   * real classification, but one the agent may still disagree with), then the IDP document type, which
   * is not a break class at all. Labelling the last two is the point — an unlabelled `wire_mismatch`
   * from IDP would read as a finding rather than as a guess about a PDF.
   */
  const classOf = (
    c: ReconCase,
  ): { text: string; suffix?: string; title?: string } => {
    if (c.class_id) return { text: c.class_id };
    const tier1 = c.item?.attributes?.tier1_break_type;
    if (tier1)
      return {
        text: String(tier1),
        suffix: "tier1",
        title:
          "Tier-1 suggested this class from the item's shape; the agent has not classified it yet and may reach a different answer",
      };
    const idp = c.item?.attributes?.idp_class;
    if (idp)
      return {
        text: String(idp),
        suffix: "idp",
        title: "IDP document class (agent has not classified yet)",
      };
    return { text: "—" };
  };

  // Rebuilt when the selection changes, because the checkbox cells close over it. `useMemo` keeps the
  // array identity stable otherwise — `DataTable` re-reads stored layouts whenever its column set
  // changes, and a fresh array every render would do that on every keystroke in the search box.
  const columns = useMemo<DataTableColumn<ReconCase>[]>(
    () => [
      {
        id: "select",
        // Pinned: hiding this would take the bulk-action bar with it, and nothing about the table
        // afterwards would explain where the bulk actions went.
        pinned: true,
        width: "auto",
        header: (
          <input
            type="checkbox"
            aria-label="Select all"
            checked={selCount > 0 && selCount === shown.length}
            onChange={toggleAll}
            className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
          />
        ),
        cell: (c) => (
          <input
            type="checkbox"
            aria-label={`Select ${c.item_id}`}
            checked={selected.has(c.item_id)}
            onChange={() => toggle(c.item_id)}
            // The row navigates on click; ticking a box must not also leave the page.
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
          />
        ),
      },
      {
        id: "item",
        header: "Item",
        width: "1.4fr",
        sortValue: (c) => c.item_id,
        cell: (c) => (
          <span className="rc-mono text-[13px] text-[var(--rc-ink)]">
            {c.item_id}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        sortValue: (c) => c.status,
        cell: (c) => <StatusPill status={c.status} />,
      },
      {
        id: "class",
        header: "Class",
        sortValue: (c) => classOf(c).text,
        cell: (c) => {
          const { text, suffix, title } = classOf(c);
          return (
            <span
              className="rc-mono text-[12px] text-[var(--rc-ink-dim)]"
              title={title}
            >
              {text}
              {suffix && (
                <span className="text-[var(--rc-ink-faint)]"> · {suffix}</span>
              )}
            </span>
          );
        },
      },
      {
        id: "confidence",
        header: "Confidence",
        width: "1.6fr",
        // Parsed to a number so 0.9 sorts above 0.15 — a string compare would put "0.15" first.
        // Absent confidence sorts last in both directions (see DataTable), which is right here: a case
        // with no score yet is not the least confident one, it is one nobody has scored.
        sortValue: (c) => (c.confidence ? parseFloat(c.confidence) : null),
        cell: (c) =>
          c.confidence ? (
            <ConfidenceMeter value={c.confidence} />
          ) : (
            <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
              —
            </span>
          ),
      },
      {
        id: "skill",
        header: "Skill",
        // Hidden by default. Useful when an analyst is asking why a whole group of cases scored badly,
        // and noise the rest of the time.
        defaultHidden: true,
        sortValue: (c) => c.confidence_components?.skill ?? null,
        cell: (c) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
            {c.confidence_components?.skill ?? "—"}
          </span>
        ),
      },
      {
        id: "open",
        pinned: true,
        width: "auto",
        header: "",
        cell: () => (
          <span className="rc-mono text-[16px] text-[var(--rc-ink-faint)]">
            →
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, selCount, shown.length],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Triage · Investigate · Resolve</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            {isHistory ? "Case History" : "Exception Queue"}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setCreating(true)}
            className="rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#040a10]"
          >
            + Create New
          </button>
          {cases && (
            <span className="rc-mono rc-tnum text-[13px] text-[var(--rc-ink-dim)]">
              {shown.length} {isHistory ? "item(s)" : "open"}
            </span>
          )}
        </div>
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
        <DataTable
          tableId="queue"
          sub={sub}
          columns={columns}
          rows={shown}
          rowKey={(c) => c.item_id}
          onRowClick={(c) =>
            router.push(`/recon/case/${encodeURIComponent(c.item_id)}`)
          }
        />
      )}

      {creating && (
        <NewItemModal
          onClose={() => setCreating(false)}
          onSubmitted={() => {
            // The item lands in PENDING within a second or two (DynamoDB Stream latency), so a
            // single immediate reload can legitimately miss it. Say so rather than looking broken.
            setMsg(
              "Submitted — Tier-1 is running; reload in a moment if it is not listed yet.",
            );
            void load(filter);
          }}
        />
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
