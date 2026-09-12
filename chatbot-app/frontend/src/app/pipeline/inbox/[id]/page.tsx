"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getEmail, reparseEmail } from "@/lib/pipelineApi";
import type { EmailRecord } from "@/lib/pipeline/types";
import { EmailViewer } from "@/components/pipeline/EmailViewer";
import { ParsedFieldsPanel } from "@/components/pipeline/ParsedFieldsPanel";
import { Placeholder } from "@/components/app-ui/ui";
import { StatusPill } from "@/components/pipeline/ui";

/** How often to re-read the record while the parser is still running on it. */
const POLL_MS = 3000;

export default function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [email, setEmail] = useState<EmailRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reparsing, setReparsing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      getEmail(id)
        .then((e) => {
          setEmail(e);
          // A poll that recovers clears the failure before it. The error branch below wins over
          // `email`, so one transient failure while the parser was running would otherwise hide the
          // parsed record for good — polling stops once it is PARSED, so nothing would retry.
          setError(null);
        })
        .catch((e) => setError(String(e))),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const polling = email?.status === "RECEIVED" || email?.status === "PARSING";
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const reparse = async () => {
    setReparsing(true);
    setActionError(null);
    try {
      setEmail(await reparseEmail(id));
    } catch (e) {
      setActionError(String(e));
    } finally {
      setReparsing(false);
    }
  };

  if (error) return <Placeholder kind="error">Failed to load the email — {error}</Placeholder>;
  if (!email) return <Placeholder kind="loading">◆ loading email {id}…</Placeholder>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/pipeline/inbox"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          ← Inbox
        </Link>
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">{email.email_id}</span>
      </div>
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="rc-display text-[26px] font-black leading-tight text-[var(--rc-ink)]">
          {email.subject}
        </h1>
        <StatusPill status={email.status} />
      </header>

      {actionError && (
        <Placeholder kind="error">Re-parse failed — {actionError}</Placeholder>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <EmailViewer email={email} />
        <ParsedFieldsPanel email={email} onReparse={reparse} reparsing={reparsing} />
      </div>
    </div>
  );
}
