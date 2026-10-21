"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  approveDeal,
  getDeal,
  getDealCsv,
  rejectDeal,
  retractOverrideLesson,
  updateDealFields,
} from "@/lib/pipelineApi";
import type { DealRecord, FieldOverride, FieldValues } from "@/lib/pipeline/types";
import { changedKeys, fieldDef, toCsvRows, validateFields } from "@/lib/pipeline/omsSchema";
import { isMultiOrder, orderName, ordersOf, sharedKeys } from "@/lib/pipeline/orders";
import { OrderStrip } from "@/components/pipeline/OrderStrip";
import { latestOverrides, MAX_OVERRIDE_REASON_CHARS } from "@/lib/pipeline/overrides";
import { useAppSubject } from "@/hooks/useAppSubject";
import { DealFieldGrid } from "@/components/pipeline/DealFieldGrid";
import { UploadResultPanel } from "@/components/pipeline/UploadResultPanel";
import { formatDateTime } from "@/components/pipeline/format";
import {
  BTN_CONFIRM,
  BTN_DANGER,
  BTN_LINK,
  BTN_QUIET,
  Disclosure,
  Eyebrow,
  INPUT_CLASS,
  Modal,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";
import { StatusPill } from "@/components/pipeline/ui";

const HISTORY_COLOR: Record<string, string> = {
  STAGED: "var(--rc-cyan)",
  EDITED: "var(--rc-violet)",
  LESSON_RETRACTED: "var(--rc-amber)",
  APPROVED: "var(--rc-violet)",
  UPLOAD_ACCEPTED: "var(--rc-green)",
  UPLOAD_REJECTED: "var(--rc-red)",
  REJECTED: "var(--rc-red)",
};

/** Whether a person can still act on the deal: approve, reject or edit. */
function decidable(status: DealRecord["status"]): boolean {
  return status === "STAGED" || status === "UPLOAD_FAILED";
}

/** Hand the browser a file to save. */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { subject, isAdmin } = useAppSubject("pipeline");
  const [deal, setDeal] = useState<DealRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Non-null while editing. The grid edits this copy; Save sends it, Cancel drops it.
  const [draft, setDraft] = useState<FieldValues | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // Save opens the reasons dialog: every changed field is an override and needs its own reason.
  const [confirming, setConfirming] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // On a deal of several orders: the order shown and edited, and — per changed field that every
  // order shared — whether the override applies to all of them (the default) or to this one.
  const [orderIndex, setOrderIndex] = useState(0);
  const [onlyThisOrder, setOnlyThisOrder] = useState<Record<string, boolean>>({});

  const load = useCallback(
    () =>
      getDeal(id)
        .then(setDeal)
        .catch((e) => setError(String(e))),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Validation runs on the draft as it is typed, with the same rules the PATCH applies server-side.
  // Only the fields this draft changes block Save — the PATCH validates exactly those — so a column
  // the parser left blank does not hold every other correction hostage; the OMS still checks it.
  const orders = useMemo(() => (deal ? ordersOf(deal) : []), [deal]);
  const sel = Math.min(orderIndex, Math.max(orders.length - 1, 0));
  const problems = useMemo(() => (draft ? validateFields(draft) : {}), [draft]);
  const changed = useMemo(
    () => (orders[sel] && draft ? changedKeys(orders[sel].fields, draft) : []),
    [orders, sel, draft],
  );
  const blocking = changed.filter((k) => problems[k]).length;
  const otherProblems = Object.keys(problems).length - blocking;

  // Every order's row, the draft in place of the order being edited.
  const csv = useMemo(
    () => toCsvRows(orders.map((o, i) => (i === sel && draft ? draft : o.fields))),
    [orders, sel, draft],
  );

  if (error) return <Placeholder kind="error">Failed to load the deal — {error}</Placeholder>;
  if (!deal) return <Placeholder kind="loading">◆ loading deal {id}…</Placeholder>;

  const editing = draft !== null;
  const open = decidable(deal.status);
  const multi = isMultiOrder(deal);
  const order = orders[sel];
  const shared = multi ? sharedKeys(orders) : null;
  const edited = orders.flatMap((o) => changedKeys(o.original_fields, o.fields));
  const reasonsComplete = changed.every((k) => (reasons[k] ?? "").trim() !== "");

  const run = async (label: string, action: () => Promise<DealRecord | void>) => {
    setBusy(label);
    setActionError(null);
    try {
      const next = await action();
      if (next) setDeal(next);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Changed fields every order shared that the reviewer applies to all orders. */
  const forAll = (k: string) => Boolean(shared?.has(k)) && !onlyThisOrder[k];

  const save = () =>
    run("save", async () => {
      // One request per scope: fields for this order, then fields for every order. A single-order
      // deal sends one request without `orders`, as it always did.
      const groups = multi
        ? [
            { keys: changed.filter((k) => !forAll(k)), orders: [sel] },
            { keys: changed.filter(forAll), orders: orders.map((_, i) => i) },
          ]
        : [{ keys: changed, orders: undefined }];
      let next: DealRecord | undefined;
      for (const g of groups) {
        if (g.keys.length === 0) continue;
        next = await updateDealFields(
          id,
          Object.fromEntries(g.keys.map((k) => [k, draft![k] ?? ""])),
          Object.fromEntries(g.keys.map((k) => [k, (reasons[k] ?? "").trim()])),
          g.orders,
        );
        setDeal(next);
      }
      setDraft(null);
      setConfirming(false);
      setReasons({});
      setOnlyThisOrder({});
      return next;
    });

  const cancelEdit = () => {
    setDraft(null);
    setReasons({});
    setOnlyThisOrder({});
  };

  const reject = () =>
    run("reject", async () => {
      const next = await rejectDeal(id, reason.trim());
      setRejecting(false);
      setReason("");
      return next;
    });

  // The route decides; this only hides the action from viewers it would refuse.
  const retractFor = (o: FieldOverride) =>
    isAdmin || (subject !== "" && o.actor === subject)
      ? async (target: FieldOverride) => setDeal(await retractOverrideLesson(id, target.override_id))
      : undefined;

  const download = () =>
    run("download", async () => {
      downloadText(`${deal.deal_id}.csv`, await getDealCsv(id));
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/pipeline/deals"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          ← Deals
        </Link>
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">{deal.deal_id}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Eyebrow>Deal review</Eyebrow>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <h1 className="rc-display text-[30px] font-black leading-none text-[var(--rc-ink)]">
              {deal.opportunity_name || "Untitled deal"}
            </h1>
            <StatusPill status={deal.status} />
          </div>
          <p className="rc-mono mt-2 text-[11.5px] text-[var(--rc-ink-faint)]">
            from{" "}
            <Link
              href={`/pipeline/inbox/${encodeURIComponent(deal.email_id)}`}
              className="text-[var(--rc-cyan)] hover:underline"
            >
              email {deal.email_id}
            </Link>
            {" · "}created {formatDateTime(deal.created_at)}
            {edited.length > 0 && (
              <>
                {" · "}
                <span className="text-[var(--rc-violet)]">
                  {edited.length} field{edited.length === 1 ? "" : "s"} edited since parsing
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={busy !== null || changed.length === 0 || blocking > 0}
                className={BTN_CONFIRM}
                title={
                  blocking > 0
                    ? `${blocking} changed field(s) still invalid`
                    : changed.length === 0
                      ? "no field changed yet"
                      : undefined
                }
              >
                Save…
              </button>
              <button type="button" onClick={cancelEdit} disabled={busy !== null} className={BTN_LINK}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {open && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...order.fields })}
                  disabled={busy !== null}
                  className={BTN_QUIET}
                >
                  Edit fields
                </button>
              )}
              <button type="button" onClick={download} disabled={busy !== null} className={BTN_QUIET}>
                {busy === "download" ? "Preparing…" : "Download CSV"}
              </button>
              {open && isAdmin && (
                <>
                  <button
                    type="button"
                    onClick={() => run("approve", () => approveDeal(id))}
                    disabled={busy !== null}
                    className={BTN_CONFIRM}
                    title="Approve and send the staging file to the OMS"
                  >
                    {busy === "approve" ? "Uploading…" : "Approve & upload"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(true)}
                    disabled={busy !== null}
                    className={BTN_DANGER}
                  >
                    Reject
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </header>

      {open && !isAdmin && (
        <p className="rc-mono text-[11.5px] text-[var(--rc-ink-faint)]">
          Approving or rejecting requires membership of the admin group; fields can still be edited.
        </p>
      )}
      {actionError && <Placeholder kind="error">{actionError}</Placeholder>}
      {editing && blocking > 0 && (
        <p className="rc-mono text-[12px]" style={{ color: "var(--rc-red)" }}>
          {blocking} changed field{blocking === 1 ? "" : "s"} would be rejected by the OMS — fix
          them to save.
        </p>
      )}
      {editing && otherProblems > 0 && (
        <p className="rc-mono text-[12px]" style={{ color: "var(--rc-amber)" }}>
          {otherProblems} other field{otherProblems === 1 ? "" : "s"} would also be rejected on
          upload; they do not block saving these changes.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {multi && (
            // Locked while editing: a draft belongs to one order, and switching would drop it.
            <fieldset disabled={editing} className="disabled:opacity-60">
              <OrderStrip orders={orders} selected={sel} deal={deal} onSelect={setOrderIndex} />
            </fieldset>
          )}
          <Eyebrow>
            OMS staging fields{multi ? ` · ${sel + 1} · ${orderName(orders, sel)}` : ""} ·{" "}
            {editing ? "editing" : "as staged"}
          </Eyebrow>
          <DealFieldGrid
            fields={draft ?? order.fields}
            original={order.original_fields}
            evidence={order.evidence}
            editing={editing}
            problems={problems}
            overrides={latestOverrides(deal, sel)}
            onRetract={retractFor}
            onChange={(key, value) => setDraft((d) => ({ ...(d ?? order.fields), [key]: value }))}
          />
        </div>

        <div className="space-y-6">
          <UploadResultPanel
            upload={deal.upload}
            dealId={deal.deal_id}
            orderLabels={multi ? orders.map((_, i) => orderName(orders, i)) : undefined}
          />

          <Panel className="rc-rise p-5">
            <Eyebrow>Staging CSV · {editing ? "preview of the draft" : deal.csv_key}</Eyebrow>
            <pre className="rc-mono mt-3 max-h-[260px] overflow-auto whitespace-pre rounded bg-[var(--rc-panel-2)] p-3 text-[11px] leading-relaxed text-[var(--rc-ink)]">
              {csv}
            </pre>
          </Panel>

          <Panel className="rc-rise p-5">
            <Eyebrow>History</Eyebrow>
            <ol className="mt-3 space-y-3">
              {[...deal.history].reverse().map((h, i) => (
                <li key={`${h.at}-${i}`} className="grid grid-cols-[auto_1fr] gap-3">
                  <span
                    className="mt-1.5 inline-block h-2 w-2 rounded-full"
                    style={{
                      background: HISTORY_COLOR[h.action] ?? "var(--rc-ink-faint)",
                      boxShadow: `0 0 6px ${HISTORY_COLOR[h.action] ?? "transparent"}`,
                    }}
                  />
                  <div>
                    <div className="rc-mono text-[12px] text-[var(--rc-ink)]">
                      {h.action.replace(/_/g, " ")}
                      <span className="text-[var(--rc-ink-faint)]"> · {h.actor}</span>
                    </div>
                    <div className="rc-mono text-[10.5px] text-[var(--rc-ink-faint)]">
                      {formatDateTime(h.at)}
                    </div>
                    {h.detail && (
                      <div className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
                        {h.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Disclosure
            summary={
              <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
                Parse context
                <span className="text-[var(--rc-ink-faint)]">
                  {" "}· {deal.assumptions.length} assumption{deal.assumptions.length === 1 ? "" : "s"}
                  {" "}· {deal.memory_hits.length} memor{deal.memory_hits.length === 1 ? "y" : "ies"} recalled
                </span>
              </span>
            }
          >
            <div className="space-y-3 p-4">
              <div>
                <Eyebrow>Skills</Eyebrow>
                <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink)]">
                  {deal.skills_used.join(", ") || "—"}
                </p>
              </div>
              <div>
                <Eyebrow>Memories recalled</Eyebrow>
                {deal.memory_hits.length === 0 ? (
                  <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink-faint)]">none</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {deal.memory_hits.map((m, i) => (
                      <li key={m.record_id ?? i} className="text-[12px] leading-relaxed text-[var(--rc-ink)]">
                        {m.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <Eyebrow>Assumptions</Eyebrow>
                {deal.assumptions.length === 0 ? (
                  <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink-faint)]">none</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {deal.assumptions.map((a, i) => (
                      <li key={i} className="border-l-2 border-[var(--rc-amber)] pl-3 text-[12px] leading-relaxed text-[var(--rc-ink)]">
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Disclosure>
        </div>
      </div>

      {confirming && draft && (
        <Modal
          title={`Why ${changed.length === 1 ? "this override" : `these ${changed.length} overrides`}?`}
          subtitle="Each reason is saved on the deal and sent to the parser's memory, so the next similar email is parsed the way you corrected this one."
          onClose={() => setConfirming(false)}
          className="max-w-2xl"
        >
          <ul className="space-y-4">
            {changed.map((k) => {
              const label = fieldDef(k)?.label ?? k;
              return (
                <li key={k} className="space-y-1.5">
                  <div className="rc-mono text-[12px] text-[var(--rc-ink)]">
                    {label}
                    <span className="text-[var(--rc-ink-faint)]">
                      {" "}· {order.fields[k] || "(blank)"} → {draft[k] || "(blank)"}
                    </span>
                  </div>
                  {shared?.has(k) && (
                    <label className="rc-mono flex items-center gap-1.5 text-[11px] text-[var(--rc-ink-dim)]">
                      <input
                        type="checkbox"
                        checked={!onlyThisOrder[k]}
                        onChange={(e) => setOnlyThisOrder((m) => ({ ...m, [k]: !e.target.checked }))}
                      />
                      apply to all {orders.length} orders (every order has this value) — one lesson
                    </label>
                  )}
                  <textarea
                    aria-label={`Reason for overriding ${label}`}
                    value={reasons[k] ?? ""}
                    onChange={(e) => setReasons((r) => ({ ...r, [k]: e.target.value }))}
                    maxLength={MAX_OVERRIDE_REASON_CHARS}
                    rows={2}
                    placeholder="What the parser got wrong, and the rule that gives the right value…"
                    className={`${INPUT_CLASS} w-full leading-relaxed`}
                  />
                </li>
              );
            })}
          </ul>
          {/* The page's own error line sits behind this overlay, so a failed save says so here. */}
          {actionError && <Placeholder kind="error">{actionError}</Placeholder>}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={busy !== null || !reasonsComplete}
              className={BTN_CONFIRM}
            >
              {busy === "save"
                ? "Saving…"
                : `Save ${changed.length} override${changed.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy !== null} className={BTN_LINK}>
              Back to editing
            </button>
          </div>
        </Modal>
      )}

      {rejecting && (
        <Modal
          title="Reject this deal?"
          subtitle="The deal leaves the review queue and nothing is sent to the OMS. The reason is recorded in the deal's history."
          onClose={() => setRejecting(false)}
          className="max-w-xl"
        >
          <textarea
            aria-label="Rejection reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why this deal is not going into the pipeline…"
            className={`${INPUT_CLASS} w-full leading-relaxed`}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={reject}
              disabled={busy !== null || !reason.trim()}
              className={BTN_DANGER}
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" onClick={() => setRejecting(false)} disabled={busy !== null} className={BTN_LINK}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
