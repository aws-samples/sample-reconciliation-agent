"use client";

import type { EmailRecord } from "@/lib/pipeline/types";
import { formatDateTime, sourceLabel } from "@/components/pipeline/format";
import { Eyebrow, Panel } from "@/components/pipeline/ui";

/** One header line. Absent values are skipped rather than shown as a dash — a missing Cc is normal. */
function Header({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <>
      <dt className="dp-eyebrow pt-0.5">{label}</dt>
      <dd className="dp-mono break-words text-[12px] text-[var(--dp-ink)]">
        {value}
      </dd>
    </>
  );
}

/**
 * The email as it arrived: headers, then the body in monospace with its line breaks kept.
 *
 * Monospace on purpose. Bank notices are column-aligned term sheets (`Borrower:   …`), and a
 * proportional font destroys the alignment the parser's evidence excerpts point back into.
 */
export function EmailViewer({ email }: { email: EmailRecord }) {
  return (
    <Panel className="dp-rise p-5">
      <Eyebrow>Email · as received</Eyebrow>
      <h2 className="mt-2 text-[15px] font-medium leading-snug text-[var(--dp-ink)]">
        {email.subject}
      </h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-[var(--dp-line)] pb-3">
        <Header label="From" value={email.from} />
        <Header label="To" value={email.to} />
        <Header label="Cc" value={email.cc} />
        <Header label="Sent" value={formatDateTime(email.sent)} />
        <Header label="Received" value={formatDateTime(email.received_at)} />
        <Header label="Source" value={sourceLabel(email.source_kind)} />
        <Header label="Sample" value={email.sample_id ?? undefined} />
      </dl>
      <pre className="dp-mono mt-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--dp-ink)]">
        {email.body}
      </pre>
    </Panel>
  );
}
