"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadColumnPrefs,
  saveColumnPrefs,
  type ColumnPref,
} from "@/lib/columnPrefs";

// One table, used by every list in the console. What it adds over hand-written markup is the three
// things an analyst asks for on the second day: sort by a column, hide the columns they never read, and
// put the ones they do read next to each other. Visibility and order survive a reload, per viewer.
//
// Sorting is client-side, over the rows the caller has already fetched. When the caller is paging
// server-side that is a real limit and the table says so out loud, because "sort by date" quietly
// meaning "sort the 50 rows I happen to have" reads as bad data rather than as a bounded view.

/** One column. `id` is the persistence key, so renaming it resets everyone's layout for that column. */
export interface DataTableColumn<T> {
  id: string;
  /** Usually a label. A node so a column can carry a control — the Queue's select-all lives here. */
  header: React.ReactNode;
  /** Cell renderer. Returning a node lets a status pill and a plain string share one API. */
  cell: (row: T) => React.ReactNode;
  /** Sort key. Omit to make the column unsortable, which is right for an action or a rendered meter. */
  sortValue?: (row: T) => string | number | null;
  /** Hidden until someone asks for it. A table that opens with fifteen columns is unreadable. */
  defaultHidden?: boolean;
  /**
   * Part of the table's machinery rather than its data — a select-all checkbox, a row-open arrow.
   * Pinned columns hold their declared position and are left out of the picker: hiding the select-all
   * box would take the bulk actions with it, and nothing about that would look deliberate afterwards.
   */
  pinned?: boolean;
  /** CSS grid track for this column. Defaults to `minmax(0,1fr)`. */
  width?: string;
}

export interface DataTableProps<T> {
  /** Namespaces the stored layout. Stable across releases; changing it discards everyone's layout. */
  tableId: string;
  /**
   * The viewer's OIDC subject, from `useReconSubject()`. Empty until `/api/recon/me` answers — the
   * table then renders the default columns and stores nothing. Never pass a placeholder: one shared
   * key means one shared layout, and on a shared browser that is somebody else's.
   */
  sub: string;
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /**
   * Detail for one row, rendered full-width directly beneath it. Return null for every row that is not
   * open — the caller owns which one that is, because it owns the click handler that opened it.
   *
   * Full-width and outside the column grid on purpose: a detail block laid out on `width`-sized tracks
   * would inherit the table's columns, so a wide preview would either be squeezed into one track or
   * push every header out of alignment with the cells above it.
   */
  expandedRow?: (row: T) => React.ReactNode;
  /** Shown when `rows` is empty. Deliberately separate from loading and from an error — a 403 that
   *  renders as "nothing recorded yet" is a bug report nobody files. */
  empty?: React.ReactNode;
  /** True when `rows` is one page of a larger server-side result, so sorting is scoped to this page. */
  paginated?: boolean;
}

type SortDir = "asc" | "desc";

/** The columns as shipped, in shipped order — the reconciliation baseline for a stored layout. */
function defaultsOf<T>(columns: DataTableColumn<T>[]): ColumnPref[] {
  return columns
    .filter((c) => !c.pinned)
    .map((c) => ({ id: c.id, visible: !c.defaultHidden }));
}

export function DataTable<T>({
  tableId,
  sub,
  columns,
  rows,
  rowKey,
  onRowClick,
  expandedRow,
  empty,
  paginated,
}: DataTableProps<T>) {
  const defaults = useMemo(() => defaultsOf(columns), [columns]);
  const [prefs, setPrefs] = useState<ColumnPref[]>(defaults);
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(null);
  const [picking, setPicking] = useState(false);
  const dragging = useRef<string | null>(null);

  // Re-read when the subject arrives (one render later than the first paint) and when the table's own
  // column set changes under us.
  useEffect(() => {
    setPrefs(loadColumnPrefs(tableId, sub, defaults));
  }, [tableId, sub, defaults]);

  const persist = (next: ColumnPref[]) => {
    setPrefs(next);
    saveColumnPrefs(tableId, sub, next);
  };

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  // The rendered column order. Pinned columns stay where they were declared; everything between the
  // first and last of them is the viewer's business. Built by walking the declared array and splicing
  // the whole reorderable set in at the position of the first reorderable column.
  const shownColumns = useMemo(() => {
    const reorderable = prefs
      .filter((p) => p.visible)
      .map((p) => byId.get(p.id))
      .filter((c): c is DataTableColumn<T> => Boolean(c));
    const out: DataTableColumn<T>[] = [];
    let spliced = false;
    for (const c of columns) {
      if (c.pinned) {
        out.push(c);
        continue;
      }
      if (!spliced) {
        out.push(...reorderable);
        spliced = true;
      }
    }
    if (!spliced) out.push(...reorderable);
    return out;
  }, [columns, prefs, byId]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = byId.get(sort.id);
    if (!col?.sortValue) return rows;
    const read = col.sortValue;
    // Copy: sorting the caller's array in place would mutate their state.
    return [...rows].sort((a, b) => {
      const av = read(a);
      const bv = read(b);
      // Missing values sort last in both directions. A blank is not "earliest" or "smallest"; it is an
      // absence, and burying it under a descending sort would hide exactly the rows worth chasing.
      if (av === null || av === undefined) return bv === null ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, byId]);

  /** Advance one column's sort: unsorted → ascending → descending → unsorted. */
  const cycleSort = (id: string) => {
    setSort((prev) => {
      if (prev?.id !== id) return { id, dir: "asc" };
      if (prev.dir === "asc") return { id, dir: "desc" };
      return null;
    });
  };

  const drop = (targetId: string) => {
    const from = dragging.current;
    dragging.current = null;
    if (!from || from === targetId) return;
    const next = [...prefs];
    const fromIdx = next.findIndex((p) => p.id === from);
    const toIdx = next.findIndex((p) => p.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    persist(next);
  };

  const template = shownColumns
    .map((c) => c.width ?? "minmax(0,1fr)")
    .join(" ");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-3">
        {paginated && sort && (
          <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
            Sorted within the {rows.length} rows loaded here, not the whole
            table.
          </span>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setPicking((p) => !p)}
            className="rc-mono rounded border border-[var(--rc-line)] px-3 py-1 text-[11px] uppercase tracking-[0.1em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)]"
          >
            Columns
          </button>
          {picking && (
            <div className="absolute right-0 z-20 mt-1 w-56 rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3 shadow-lg">
              <p className="rc-eyebrow mb-2">Show columns</p>
              {prefs.map((p) => (
                <label
                  key={p.id}
                  className="rc-mono flex items-center gap-2 py-1 text-[12px] text-[var(--rc-ink-dim)]"
                >
                  <input
                    type="checkbox"
                    checked={p.visible}
                    onChange={() =>
                      persist(
                        prefs.map((q) =>
                          q.id === p.id ? { ...q, visible: !q.visible } : q,
                        ),
                      )
                    }
                    className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                  />
                  {/* The header can be a control, so fall back to the id rather than rendering a
                      checkbox inside the picker. */}
                  {typeof byId.get(p.id)?.header === "string"
                    ? (byId.get(p.id)?.header as string)
                    : p.id}
                </label>
              ))}
              <button
                type="button"
                onClick={() => persist(defaults)}
                className="rc-mono mt-2 text-[11px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
              >
                Reset
              </button>
            </div>
          )}
        </div>
      </div>

      {/* `rc-panel` carries the surface, not just the border. Without it the page's grid background
          shows straight through the rows, and a row you can see the backdrop through is a row you have
          to work to read — which is what the hand-written tables this component replaced got right by
          sitting inside a Panel. The header takes a second, fainter fill so the column labels read as
          chrome rather than as a first row of data. */}
      <div className="rc-panel rc-rise overflow-hidden">
        <div
          className="grid items-center gap-4 border-b border-[var(--rc-line)] bg-[var(--rc-line-soft)]/40 px-5 py-3"
          style={{ gridTemplateColumns: template }}
        >
          {shownColumns.map((c) => {
            const isSorted = sort?.id === c.id;
            return (
              <div
                key={c.id}
                draggable={!c.pinned}
                onDragStart={() => {
                  dragging.current = c.id;
                }}
                onDragOver={(e) => {
                  if (!c.pinned) e.preventDefault();
                }}
                onDrop={() => {
                  if (!c.pinned) drop(c.id);
                }}
                className="rc-eyebrow flex items-center gap-1"
              >
                {c.sortValue ? (
                  <button
                    type="button"
                    onClick={() => cycleSort(c.id)}
                    title="Sort by this column"
                    className="rc-eyebrow hover:text-[var(--rc-ink)]"
                    style={{ color: isSorted ? "var(--rc-cyan)" : undefined }}
                  >
                    {c.header}
                    {isSorted ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                ) : (
                  c.header
                )}
              </div>
            );
          })}
        </div>

        {sorted.length === 0
          ? empty !== undefined && (
              <div className="rc-mono px-5 py-6 text-[12px] text-[var(--rc-ink-faint)]">
                {empty}
              </div>
            )
          : sorted.map((row) => {
              const detail = expandedRow?.(row) ?? null;
              return (
                // The row divider moved to this wrapper so an open detail block sits INSIDE the same
                // bordered unit as the row it belongs to, rather than reading as the next row's header.
                <div
                  key={rowKey(row)}
                  className="border-b border-[var(--rc-line-soft)] last:border-0"
                >
                  <div
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className="rc-row grid items-center gap-4 px-5 py-4"
                    style={{
                      gridTemplateColumns: template,
                      cursor: onRowClick ? "pointer" : undefined,
                    }}
                  >
                    {shownColumns.map((c) => (
                      <div key={c.id} className="min-w-0">
                        {c.cell(row)}
                      </div>
                    ))}
                  </div>
                  {detail !== null && (
                    // Not inside the clickable row: a click anywhere in the detail would otherwise
                    // re-fire `onRowClick`, which on a toggle handler closes the panel the viewer just
                    // reached for.
                    <div className="border-t border-[var(--rc-line-soft)] bg-[var(--rc-line-soft)]/20 px-5 py-4">
                      {detail}
                    </div>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}
