"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listCases, bulkUpdateCases, type ReconCase } from "@/lib/reconApi";
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

/**
 * Item-level attribute keys that already have a purpose-built column, so the derived set skips them.
 *
 * `tier1_break_type` is here because the Class column already renders it, labelled as a Tier-1 guess —
 * offering it a second time unlabelled would put the same value on the row twice with two different
 * meanings.
 */
const ATTRIBUTES_WITH_THEIR_OWN_COLUMN = new Set([
  "tier1_break_type",
  "tier1_escalation_reason",
  "idp_class",
  "idp_classification_confidence",
  "idp_confidence_alert_count",
]);

/**
 * Whether an item attribute is worth offering as a column.
 *
 * Scalars only. The hook stamps whole structures onto the same bag (`idp_sections` carries every
 * extracted field of every section, `idp_pages` every page image), and a table cell is not where
 * anybody reads those — the case page's IDP panel is. Rendering them here would be a column of
 * `[object Object]` per row, which reads as a bug rather than as a deliberate omission.
 *
 * @param value - the attribute's value on one row.
 * @returns true when the value can be shown in a cell.
 */
function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** A cell value as text. Scalars only reach here, so this never has to flatten a structure. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * A sort key for a derived column.
 *
 * Numbers sort as numbers when the text is one, so `"12500.00"` sorts above `"9.00"` — the side
 * attributes an analyst most wants a column for are amounts, and a string compare gets those wrong.
 * Anything else sorts as text, and an absence sorts last in both directions (see `DataTable`).
 *
 * @param value - the raw attribute value.
 * @returns a number, a string, or null for an absence.
 */
function derivedSortValue(value: unknown): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const text = String(value);
  const asNumber = Number(text);
  return text.trim() !== "" && Number.isFinite(asNumber) ? asNumber : text;
}

/**
 * A plain text cell in the queue's body style.
 *
 * Truncated with the full value on hover, because a derived column can hold a reference string far
 * wider than its track and a cell that pushes the grid out of alignment costs every other column.
 *
 * @param text - the already-formatted value, or an em dash for an absence.
 */
function TextCell({ text }: { text: string }) {
  return (
    <span
      className="rc-mono block truncate text-[12px] text-[var(--rc-ink-dim)]"
      title={text === "—" ? undefined : text}
    >
      {text}
    </span>
  );
}

/** One column derived from the loaded rows rather than declared in the page. */
interface DerivedColumn {
  id: string;
  header: string;
  read: (c: ReconCase) => unknown;
}

/**
 * The columns the loaded cases themselves imply: one per side attribute, one per scalar item attribute.
 *
 * Derived rather than declared because the submitted item is free-form. `sides[].attributes` is
 * whatever the two systems being reconciled happen to carry, and the item's own `attributes` bag mixes
 * the submitter's keys with the `tier1_*`/`idp_*` ones the platform stamps on. A fixed column list
 * cannot cover that, which is why the queue showed none of it.
 *
 * Derived from ALL loaded cases, not the filtered ones: a column set that changed while somebody typed
 * in the search box would reshuffle the table under them and, because `DataTable` re-reads the stored
 * layout whenever its column set changes, do it once per keystroke.
 *
 * @param cases - every case loaded for the current filter.
 * @returns the derived columns, side attributes first, each group in key order.
 */
function deriveColumns(cases: ReconCase[]): DerivedColumn[] {
  // Sides in first-seen order — `bank` before `ledger` because that is how the submitter listed them,
  // which is the order the two sides are read in everywhere else.
  const sideKeys = new Map<string, Set<string>>();
  const attributeKeys = new Set<string>();
  for (const c of cases) {
    for (const side of c.item?.sides ?? []) {
      const name = side.name?.trim();
      if (!name) continue;
      const keys = sideKeys.get(name) ?? new Set<string>();
      for (const key of Object.keys(side.attributes ?? {})) keys.add(key);
      sideKeys.set(name, keys);
    }
    for (const [key, value] of Object.entries(c.item?.attributes ?? {})) {
      if (ATTRIBUTES_WITH_THEIR_OWN_COLUMN.has(key)) continue;
      // Offered as soon as ONE row carries a scalar there. A key that is a structure on every row it
      // appears on never becomes a column; one that is a string on some rows does, and the rows where
      // it is a structure show an em dash.
      if (isScalar(value)) attributeKeys.add(key);
    }
  }

  const out: DerivedColumn[] = [];
  for (const [name, keys] of sideKeys) {
    for (const key of [...keys].sort()) {
      out.push({
        // Namespaced so a side attribute and an item attribute of the same name are two columns with
        // two stored layouts, not one that silently wins.
        id: `side:${name}:${key}`,
        header: `${name} · ${key}`,
        read: (c) =>
          c.item?.sides?.find((s) => s.name === name)?.attributes?.[key],
      });
    }
  }
  for (const key of [...attributeKeys].sort()) {
    out.push({
      id: `attr:${key}`,
      header: key,
      read: (c) => c.item?.attributes?.[key],
    });
  }
  return out;
}

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
    return listCases(opts)
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

  // Rebuilt only when the loaded cases change, so the identity is stable across renders — `DataTable`
  // re-reads its stored layout whenever its column set changes, and rebuilding this on every render
  // would do that on every keystroke in the search box.
  const derived = useMemo(() => deriveColumns(cases ?? []), [cases]);

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
        // Fixed, not `auto`: the header and the body are separate grids, so a content-sized track can
        // resolve to two different widths and knock every label out of line with its column. This is
        // the checkbox's own `w-3.5`.
        width: "0.875rem",
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
      // --- The submitted item, spelled out ---
      // All hidden by default. `/api/recon/cases` has always returned the whole item, so every one of
      // these was already in the browser with no column to put it in.
      {
        id: "domain",
        header: "Domain",
        defaultHidden: true,
        sortValue: (c) => c.item?.domain ?? null,
        cell: (c) => <TextCell text={c.item?.domain ?? "—"} />,
      },
      {
        id: "tier",
        header: "Tier",
        defaultHidden: true,
        // A number, so tier 10 would sort below tier 9 as text.
        sortValue: (c) => c.item?.tier ?? null,
        cell: (c) => <TextCell text={c.item?.tier?.toString() ?? "—"} />,
      },
      {
        id: "source_refs",
        header: "Source refs",
        width: "1.4fr",
        defaultHidden: true,
        // Sorted on the first ref rather than the count: the refs are what an analyst scans for, and
        // "how many refs" is not a question anybody asks of this column.
        sortValue: (c) => c.item?.source_refs?.[0] ?? null,
        cell: (c) => <TextCell text={c.item?.source_refs?.join(", ") || "—"} />,
      },
      {
        id: "tier1_escalation_reason",
        header: "Escalation reason",
        width: "1.6fr",
        defaultHidden: true,
        sortValue: (c) =>
          (c.item?.attributes?.tier1_escalation_reason as string) ?? null,
        cell: (c) => (
          <TextCell
            text={
              (c.item?.attributes?.tier1_escalation_reason as string) || "—"
            }
          />
        ),
      },
      {
        id: "idp_class",
        header: "IDP class",
        defaultHidden: true,
        sortValue: (c) => (c.item?.attributes?.idp_class as string) ?? null,
        cell: (c) => (
          <TextCell text={(c.item?.attributes?.idp_class as string) || "—"} />
        ),
      },
      {
        id: "idp_classification_confidence",
        header: "IDP confidence",
        defaultHidden: true,
        // The hook stamps this as a string; parsed so it sorts as the number it is. Distinct from the
        // Confidence column, which is the AGENT's score for the case — this one is how sure IDP was
        // that the PDF is the class it called it.
        sortValue: (c) => {
          const raw = c.item?.attributes?.idp_classification_confidence;
          return raw === undefined || raw === null ? null : Number(raw);
        },
        cell: (c) => (
          <TextCell
            text={scalarText(c.item?.attributes?.idp_classification_confidence)}
          />
        ),
      },
      {
        id: "idp_confidence_alert_count",
        header: "Low-confidence fields",
        defaultHidden: true,
        sortValue: (c) => {
          const raw = c.item?.attributes?.idp_confidence_alert_count;
          return raw === undefined || raw === null ? null : Number(raw);
        },
        cell: (c) => (
          <TextCell
            text={scalarText(c.item?.attributes?.idp_confidence_alert_count)}
          />
        ),
      },
      // --- Whatever else the submitter sent ---
      // One column per side attribute and per scalar item attribute actually present in the loaded
      // rows. Hidden by default like the rest: this set runs to dozens on a mixed queue, and a table
      // that opened with all of them showing would be unreadable.
      ...derived.map((d) => ({
        id: d.id,
        header: d.header,
        width: "1.2fr",
        defaultHidden: true,
        sortValue: (c: ReconCase) => derivedSortValue(d.read(c)),
        cell: (c: ReconCase) => {
          const value = d.read(c);
          // A row whose value is a structure where other rows hold a scalar reads as an absence rather
          // than as `[object Object]` — see `isScalar` for why those never become columns of their own.
          return <TextCell text={isScalar(value) ? scalarText(value) : "—"} />;
        },
      })),
      {
        id: "open",
        pinned: true,
        // THE column that caused the drift. Its header is empty and its cell is an arrow, so an `auto`
        // track measured 0px in the header grid and ~10px in the row grid — and the whole ~10px
        // difference was redistributed across the flexible tracks to its left, which is why every
        // header label sat progressively further from the values beneath it.
        width: "1rem",
        header: "",
        cell: () => (
          <span className="rc-mono text-[16px] text-[var(--rc-ink-faint)]">
            →
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, selCount, shown.length, derived],
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
