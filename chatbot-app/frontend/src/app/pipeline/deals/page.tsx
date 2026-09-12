"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listDeals } from "@/lib/pipelineApi";
import type { DealRecord, DealStatus } from "@/lib/pipeline/types";
import { useAppSubject } from "@/hooks/useAppSubject";
import { DataTable, type DataTableColumn } from "@/components/app-ui/DataTable";
import { formatDateTime } from "@/components/pipeline/format";
import { Eyebrow, Placeholder } from "@/components/app-ui/ui";
import { StatusPill } from "@/components/pipeline/ui";

// "ALL" first, then the lifecycle in order. UPLOAD_FAILED sits next to UPLOADED because that is the
// pair the desk compares: what the OMS took and what it sent back.
const FILTERS: ("ALL" | DealStatus)[] = [
  "ALL",
  "STAGED",
  "APPROVED",
  "UPLOADED",
  "UPLOAD_FAILED",
  "REJECTED",
];

/** A cell of dim monospace text, em dash for an absence. */
function Cell({ text, title }: { text: string; title?: string }) {
  return (
    <span
      className="rc-mono block truncate text-[12px] text-[var(--rc-ink-dim)]"
      title={title ?? (text === "—" ? undefined : text)}
    >
      {text}
    </span>
  );
}

/** `S+275–300` style spread summary from the two talk fields, or an absence. */
function spreadOf(d: DealRecord): string {
  const low = d.fields.initial_spread_talk_low;
  const high = d.fields.initial_spread_talk_high;
  if (!low && !high) return "—";
  if (low && high && low !== high) return `${low} – ${high}`;
  return low || high;
}

/** `USD 500.000` style size summary. */
function sizeOf(d: DealRecord): string {
  const size = d.fields.issue_size_mm;
  if (!size) return "—";
  return `${d.fields.currency ? `${d.fields.currency} ` : ""}${size}`;
}

function DealsContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { subject } = useAppSubject("pipeline");
  const initial = params.get("status");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(
    initial && FILTERS.includes(initial as DealStatus) ? (initial as DealStatus) : "ALL",
  );
  const [deals, setDeals] = useState<DealRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDeals()
      .then((list) =>
        setDeals([...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))),
      )
      .catch((e) => setError(String(e)));
  }, []);

  const changeFilter = (f: (typeof FILTERS)[number]) => {
    setFilter(f);
    router.replace(f === "ALL" ? "/pipeline/deals" : `/pipeline/deals?status=${f}`);
  };

  const shown = useMemo(
    () => (deals ?? []).filter((d) => filter === "ALL" || d.status === filter),
    [deals, filter],
  );

  const columns = useMemo<DataTableColumn<DealRecord>[]>(
    () => [
      {
        id: "opportunity",
        header: "Opportunity",
        width: "2.2fr",
        sortValue: (d) => d.opportunity_name,
        cell: (d) => (
          <span className="block truncate text-[13px] text-[var(--rc-ink)]" title={d.opportunity_name}>
            {d.opportunity_name || "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: "9rem",
        sortValue: (d) => d.status,
        cell: (d) => <StatusPill status={d.status} />,
      },
      {
        id: "type",
        header: "Type",
        width: "5rem",
        sortValue: (d) => d.fields.pipeline_type || null,
        cell: (d) => <Cell text={d.fields.pipeline_type || "—"} />,
      },
      {
        id: "issuer",
        header: "Issuer",
        width: "1.6fr",
        sortValue: (d) => d.enrichment?.issuer_match ?? null,
        cell: (d) => <Cell text={d.enrichment?.issuer_match ?? "—"} />,
      },
      {
        id: "size",
        header: "Issue size (MM)",
        width: "1.1fr",
        // Numeric so 1,295 sorts above 700; the string compare puts "700" after "1295".
        sortValue: (d) => (d.fields.issue_size_mm ? Number(d.fields.issue_size_mm) : null),
        cell: (d) => <Cell text={sizeOf(d)} />,
      },
      {
        id: "spread",
        header: "Spread talk",
        width: "1.2fr",
        sortValue: (d) => d.fields.initial_spread_talk_low || null,
        cell: (d) => <Cell text={spreadOf(d)} />,
      },
      {
        id: "left_agent",
        header: "Left agent",
        width: "1fr",
        defaultHidden: true,
        sortValue: (d) => d.fields.left_agent || null,
        cell: (d) => <Cell text={d.fields.left_agent || "—"} />,
      },
      {
        id: "commit_due",
        header: "Commit due",
        width: "1fr",
        defaultHidden: true,
        sortValue: (d) => d.fields.commit_due || null,
        cell: (d) => <Cell text={d.fields.commit_due || "—"} />,
      },
      {
        id: "created",
        header: "Created",
        width: "1.2fr",
        sortValue: (d) => d.created_at,
        cell: (d) => <Cell text={formatDateTime(d.created_at)} />,
      },
      {
        id: "upload",
        header: "Last upload",
        width: "1.1fr",
        sortValue: (d) => (d.upload ? (d.upload.accepted ? "accepted" : "rejected") : null),
        cell: (d) =>
          !d.upload ? (
            <Cell text="—" />
          ) : d.upload.accepted ? (
            <span className="rc-chip" style={{ color: "var(--rc-green)" }}>
              ✓ accepted
            </span>
          ) : (
            <span
              className="rc-chip"
              style={{ color: "var(--rc-red)" }}
              title={d.upload.errors.map((e) => e.code).join(", ")}
            >
              ✕ {d.upload.errors.length} error{d.upload.errors.length === 1 ? "" : "s"}
            </span>
          ),
      },
      {
        id: "open",
        pinned: true,
        width: "1rem",
        header: "",
        cell: () => <span className="rc-mono text-[16px] text-[var(--rc-ink-faint)]">→</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Review · approve · upload to the OMS</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            Deals
          </h1>
        </div>
        {deals && (
          <span className="rc-mono rc-tnum text-[13px] text-[var(--rc-ink-dim)]">
            {shown.length} of {deals.length}
          </span>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => changeFilter(f)}
            className="rc-mono rounded px-3 py-1 text-[11px] tracking-[0.06em]"
            style={{
              color: f === filter ? "var(--rc-ink)" : "var(--rc-ink-faint)",
              background: f === filter ? "var(--rc-panel-2)" : "transparent",
              border: f === filter ? "1px solid var(--rc-cyan)" : "1px solid var(--rc-line)",
            }}
          >
            {f.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {error ? (
        <Placeholder kind="error">Failed to load deals — {error}</Placeholder>
      ) : !deals ? (
        <Placeholder kind="loading">◆ fetching deals…</Placeholder>
      ) : shown.length === 0 ? (
        <Placeholder kind="empty">
          {filter === "ALL"
            ? "◇ no deals yet — parse an email from the inbox"
            : "◇ no deals in this status"}
        </Placeholder>
      ) : (
        <DataTable
          appId="pipeline"
          tableId="deals"
          sub={subject}
          columns={columns}
          rows={shown}
          rowKey={(d) => d.deal_id}
          onRowClick={(d) => router.push(`/pipeline/deals/${encodeURIComponent(d.deal_id)}`)}
        />
      )}
    </div>
  );
}

export default function DealsPage() {
  return (
    <Suspense fallback={<Placeholder kind="loading">◆ loading deals…</Placeholder>}>
      <DealsContent />
    </Suspense>
  );
}
