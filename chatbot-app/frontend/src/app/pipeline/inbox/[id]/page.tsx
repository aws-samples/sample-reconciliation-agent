"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getDeal,
  getEmail,
  reparseEmail,
  retractOverrideLesson,
  updateDealFields,
} from "@/lib/pipelineApi";
import type { DealRecord, EmailRecord, FieldOverride } from "@/lib/pipeline/types";
import { useAppSubject } from "@/hooks/useAppSubject";
import { isMultiOrder } from "@/lib/pipeline/orders";
import { EmailViewer } from "@/components/pipeline/EmailViewer";
import { ParsedFieldsPanel } from "@/components/pipeline/ParsedFieldsPanel";
import { Placeholder } from "@/components/app-ui/ui";
import { StatusPill } from "@/components/pipeline/ui";

/** How often to re-read the record while the parser is still running on it. */
const POLL_MS = 3000;

/** Deal statuses a reviewer can still override values in; the rest are in flight or final. */
function overridable(deal: DealRecord): boolean {
  return deal.status === "STAGED" || deal.status === "UPLOAD_FAILED";
}

export default function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { subject, isAdmin } = useAppSubject("pipeline");
  const [email, setEmail] = useState<EmailRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reparsing, setReparsing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The deal the parse staged, so the panel shows current values and can override them. Keyed by
  // its id: after a re-parse the email names a new deal, and the old one must not be shown as it.
  const [deal, setDeal] = useState<DealRecord | null>(null);
  const [dealError, setDealError] = useState<string | null>(null);

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

  const dealId = email?.deal_id ?? null;
  useEffect(() => {
    if (!dealId) return;
    let live = true;
    getDeal(dealId)
      .then((d) => {
        if (!live) return;
        setDeal(d);
        setDealError(null);
      })
      .catch((e) => {
        if (live) setDealError(String(e));
      });
    return () => {
      live = false;
    };
  }, [dealId]);
  const shownDeal = deal && deal.deal_id === dealId ? deal : null;

  const override = async (key: string, value: string, reason: string, orders: number[]) => {
    if (!shownDeal) return;
    // A single-order deal sends no `orders`, exactly the request it always sent.
    const scope = isMultiOrder(shownDeal) ? orders : undefined;
    setDeal(await updateDealFields(shownDeal.deal_id, { [key]: value }, { [key]: reason }, scope));
  };

  // The route decides; this only hides the action from viewers it would refuse.
  const retractFor = (o: FieldOverride) =>
    shownDeal && (isAdmin || (subject !== "" && o.actor === subject))
      ? async (target: FieldOverride) =>
          setDeal(await retractOverrideLesson(shownDeal.deal_id, target.override_id))
      : undefined;

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
      {dealError && dealId && (
        <Placeholder kind="error">
          Could not load deal {dealId}, so values are shown as parsed and cannot be overridden —{" "}
          {dealError}
        </Placeholder>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <EmailViewer email={email} />
        <ParsedFieldsPanel
          email={email}
          deal={shownDeal}
          onOverride={shownDeal && overridable(shownDeal) ? override : undefined}
          onRetract={retractFor}
          onReparse={reparse}
          reparsing={reparsing}
        />
      </div>
    </div>
  );
}
