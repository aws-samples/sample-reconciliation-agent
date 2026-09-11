"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listEmails } from "@/lib/pipelineApi";
import type { EmailRecord } from "@/lib/pipeline/types";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import { DataTable, type DataTableColumn } from "@/components/pipeline/DataTable";
import { SimulateEmailModal } from "@/components/pipeline/SimulateEmailModal";
import { formatDateTime, sourceLabel } from "@/components/pipeline/format";
import {
  BTN_PRIMARY,
  Eyebrow,
  Placeholder,
  StatusPill,
} from "@/components/pipeline/ui";

/** How often to re-read the list while any row is still being parsed. */
const POLL_MS = 3000;

/** Rows still moving. While any exist the page polls; once none do it stops. */
function inFlight(e: EmailRecord): boolean {
  return e.status === "RECEIVED" || e.status === "PARSING";
}

export default function InboxPage() {
  const router = useRouter();
  const { subject } = usePipelineSubject();
  const [emails, setEmails] = useState<EmailRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    () =>
      listEmails()
        .then((list) => {
          setEmails(
            [...list].sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? "")),
          );
          // A poll that recovers clears the failure before it. The error branch below wins over
          // `emails`, and nothing else resets it, so one transient failure while a row was PARSING
          // would otherwise hide the table for the rest of the visit.
          setError(null);
        })
        .catch((e) => setError(String(e))),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is in flight. Keyed on the boolean rather than on the list, so a
  // reload that changes nothing does not tear the interval down and set it up again.
  const polling = emails?.some(inFlight) ?? false;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const columns = useMemo<DataTableColumn<EmailRecord>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        width: "8.5rem",
        sortValue: (e) => e.status,
        cell: (e) => <StatusPill status={e.status} />,
      },
      {
        id: "source",
        header: "Source",
        width: "1fr",
        sortValue: (e) => e.source_kind,
        cell: (e) => (
          <span className="dp-mono text-[12px] text-[var(--dp-ink-dim)]">
            {sourceLabel(e.source_kind)}
          </span>
        ),
      },
      {
        id: "subject",
        header: "Subject",
        width: "3fr",
        sortValue: (e) => e.subject,
        cell: (e) => (
          <span className="block truncate text-[13px] text-[var(--dp-ink)]" title={e.subject}>
            {e.subject}
          </span>
        ),
      },
      {
        id: "sent",
        header: "Sent",
        width: "1.2fr",
        sortValue: (e) => e.sent,
        cell: (e) => (
          <span className="dp-mono dp-tnum text-[12px] text-[var(--dp-ink-dim)]">
            {formatDateTime(e.sent)}
          </span>
        ),
      },
      {
        id: "received",
        header: "Received",
        width: "1.2fr",
        defaultHidden: true,
        sortValue: (e) => e.received_at,
        cell: (e) => (
          <span className="dp-mono dp-tnum text-[12px] text-[var(--dp-ink-dim)]">
            {formatDateTime(e.received_at)}
          </span>
        ),
      },
      {
        id: "deal",
        header: "Deal",
        width: "1fr",
        sortValue: (e) => e.deal_id,
        cell: (e) =>
          e.deal_id ? (
            <Link
              href={`/pipeline/deals/${encodeURIComponent(e.deal_id)}`}
              // The row itself opens the email; the link must not also do that.
              onClick={(ev) => ev.stopPropagation()}
              className="dp-mono text-[12px] text-[var(--dp-cyan)] hover:underline"
            >
              open deal →
            </Link>
          ) : (
            <span className="dp-mono text-[12px] text-[var(--dp-ink-faint)]">—</span>
          ),
      },
      {
        id: "open",
        pinned: true,
        // Fixed, not `auto`: the header and the body are separate grids, and a content-sized track
        // resolves differently in each — see `DataTableColumn.width`.
        width: "1rem",
        header: "",
        cell: () => <span className="dp-mono text-[16px] text-[var(--dp-ink-faint)]">→</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Deal emails · received → parsed → staged</Eyebrow>
          <h1 className="dp-display mt-2 text-[34px] font-black leading-none text-[var(--dp-ink)]">
            Inbox
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {emails && (
            <span className="dp-mono dp-tnum text-[13px] text-[var(--dp-ink-dim)]">
              {emails.length} email{emails.length === 1 ? "" : "s"}
              {polling ? " · parsing…" : ""}
            </span>
          )}
          <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY}>
            + Simulate incoming email
          </button>
        </div>
      </header>

      {error ? (
        <Placeholder kind="error">Failed to load the inbox — {error}</Placeholder>
      ) : !emails ? (
        <Placeholder kind="loading">◆ fetching emails…</Placeholder>
      ) : emails.length === 0 ? (
        <Placeholder kind="empty">
          ◇ inbox empty — simulate an incoming email to start the pipeline
        </Placeholder>
      ) : (
        <DataTable
          tableId="inbox"
          sub={subject}
          columns={columns}
          rows={emails}
          rowKey={(e) => e.email_id}
          onRowClick={(e) => router.push(`/pipeline/inbox/${encodeURIComponent(e.email_id)}`)}
        />
      )}

      {creating && (
        <SimulateEmailModal
          onClose={() => setCreating(false)}
          onCreated={(email) =>
            router.push(`/pipeline/inbox/${encodeURIComponent(email.email_id)}`)
          }
        />
      )}
    </div>
  );
}
