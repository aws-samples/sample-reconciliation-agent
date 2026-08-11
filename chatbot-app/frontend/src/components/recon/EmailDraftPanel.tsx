"use client";

import { useEffect, useState } from "react";
import type { EmailDraft } from "@/lib/reconApi";
import { recipientRejectionReason } from "@/lib/emailPolicy";
import { Eyebrow, Panel } from "@/components/recon/ui";

// The counterparty email the agent drafted, and the analyst's decision on it.
//
// The agent cannot send this mail — it writes the text and stops. What an analyst approves here is
// what the gateway interceptor will later compare the outgoing message against, byte for byte, so
// this panel is the only place the message can be decided. Two consequences show up in the markup:
// the recipient is an input rather than a value (the model's suggestion is discarded on the way in,
// because the item under reconciliation came from a document an outside party wrote), and every
// button sends the revision being displayed, so a decision made against text that has since changed
// is refused instead of applied.
//
// Presentational: the page owns the API calls, the reload and the error line, which keeps the four
// draft states cheap to render in a test.

/** A stored timestamp, trimmed to the minute. Kept as UTC text — not localized — so the record an
 *  analyst reads matches the one in the row and in the audit trail. */
function stamp(iso?: string | null): string {
  if (!iso) return "—";
  return `${iso.slice(0, 16).replace("T", " ")}Z`;
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="rc-eyebrow mb-2 block">{label}</label>
      {children}
      {hint && (
        <p className="rc-mono mt-1 text-[11px] text-[var(--rc-ink-faint)]">
          {hint}
        </p>
      )}
    </div>
  );
}

const INPUT =
  "rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-2 text-[13px] text-[var(--rc-ink)]";
const BUTTON =
  "rc-mono rounded border px-4 py-2 text-[12px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40";

export function EmailDraftPanel({
  draft,
  caseStatus,
  allowedDomains,
  busy = false,
  overrideUnknownSend = false,
  onOverrideChange,
  onSave,
  onDecide,
}: {
  draft: EmailDraft;
  /** The case's status. Only a case still awaiting a decision has an editable draft. */
  caseStatus: string;
  allowedDomains: string[];
  /** Some other action on the case is in flight — every control here is disabled while it is. */
  busy?: boolean;
  overrideUnknownSend?: boolean;
  onOverrideChange?: (value: boolean) => void;
  onSave: (fields: {
    recipient: string;
    subject: string;
    body: string;
    revision: number;
  }) => void;
  onDecide: (
    action: "approve_draft" | "revoke_draft" | "discard_draft",
    revision: number,
  ) => void;
}) {
  const [recipient, setRecipient] = useState(draft.recipient ?? "");
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);

  // Re-sync when the stored draft moves — after a save, or after someone else edited it and the
  // page reloaded. Keyed on the revision so an in-progress edit is not clobbered by an unrelated
  // re-render, and so a revision that jumped underneath the analyst replaces what they were typing
  // rather than leaving them editing text that no longer exists.
  useEffect(() => {
    setRecipient(draft.recipient ?? "");
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.revision, draft.recipient, draft.subject, draft.body]);

  const status = draft.draft_status;
  const decided = status === "discarded" || status === "sent";
  const editable = caseStatus === "PROPOSED" && status === "pending";
  const rejection = recipientRejectionReason(recipient, allowedDomains);
  const dirty =
    recipient !== (draft.recipient ?? "") ||
    subject !== draft.subject ||
    body !== draft.body;
  // A send was claimed and never confirmed. The row cannot tell us whether the counterparty
  // received it, so the analyst has to look in the shared mailbox; offering a plain retry here
  // would be offering to double-send.
  const unknownSend = Boolean(draft.send_attempted_at) && !draft.sent_at;

  const statusColor =
    status === "approved"
      ? "var(--rc-green)"
      : status === "sent"
        ? "var(--rc-cyan)"
        : status === "discarded"
          ? "var(--rc-ink-faint)"
          : "var(--rc-amber)";

  return (
    <Panel className="rc-rise p-6" scan>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow title="The agent drafts this email but cannot send it. Approving it here is what authorizes the send — the gateway refuses any message that is not the text approved on this case at this revision.">
          Counterparty Email Draft
        </Eyebrow>
        <div className="rc-mono flex items-center gap-3 text-[11px]">
          <span className="rc-pill" style={{ color: statusColor }}>
            {status}
          </span>
          <span
            className="text-[var(--rc-ink-faint)]"
            title="Every edit bumps this. An approval names one revision and only that revision can be sent."
          >
            rev {draft.revision}
          </span>
        </div>
      </div>

      {unknownSend && (
        <div
          className="mt-4 rounded border p-3"
          style={{
            borderColor: "var(--rc-amber)",
            color: "var(--rc-amber)",
          }}
        >
          <p className="rc-mono text-[12px] leading-relaxed">
            Send state unknown — a send was started at{" "}
            {stamp(draft.send_attempted_at)} and never confirmed. Check the
            shared mailbox&apos;s Sent Items before retrying.
          </p>
          {onOverrideChange && (
            <label className="rc-mono mt-2 flex items-start gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={overrideUnknownSend}
                onChange={(e) => onOverrideChange(e.target.checked)}
                disabled={busy}
              />
              <span>
                I checked Sent Items and nothing was sent — allow one retry.
              </span>
            </label>
          )}
        </div>
      )}

      <div className="mt-4 space-y-4">
        <Field
          label="To"
          hint={
            allowedDomains.length > 0
              ? `Allowed domains: ${allowedDomains.join(", ")}`
              : "No counterparty domains are configured for this deployment, so no address can be used."
          }
        >
          {editable ? (
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={busy}
              placeholder={
                draft.recipient_hint
                  ? `Address for ${draft.recipient_hint}…`
                  : "name@counterparty.example"
              }
              aria-label="Counterparty email recipient"
              className={INPUT}
              style={
                rejection && recipient
                  ? { borderColor: "var(--rc-red)" }
                  : undefined
              }
            />
          ) : (
            <p className="rc-mono text-[13px] text-[var(--rc-ink)]">
              {draft.recipient ?? "—"}
            </p>
          )}
          {editable && rejection && recipient && (
            <p className="rc-mono mt-1 text-[11px] text-[var(--rc-red)]">
              {rejection}
            </p>
          )}
          {!draft.recipient && draft.recipient_hint && (
            <p className="rc-mono mt-1 text-[11px] text-[var(--rc-ink-faint)]">
              The agent believes this goes to {draft.recipient_hint}. It does
              not choose the address — a document from an outside party is not a
              source of one.
            </p>
          )}
        </Field>

        <Field label="Subject">
          {editable ? (
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={busy}
              aria-label="Counterparty email subject"
              className={INPUT}
            />
          ) : (
            <p className="text-[13px] text-[var(--rc-ink)]">{draft.subject}</p>
          )}
        </Field>

        <Field label="Body">
          {editable ? (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              aria-label="Counterparty email body"
              className={`${INPUT} h-48`}
            />
          ) : (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
              {draft.body}
            </p>
          )}
        </Field>
      </div>

      {/* Who did what. Kept on the draft itself rather than in the case's audit rows, whose status
          column speaks only in case statuses — none of these actions moves the case. */}
      <div className="rc-mono mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-[var(--rc-ink-faint)]">
        {draft.edited_by && (
          <span>
            edited by {draft.edited_by} · {stamp(draft.edited_at)}
          </span>
        )}
        {draft.approved_by && status !== "pending" && (
          <span>
            approved by {draft.approved_by} · {stamp(draft.approved_at)}
          </span>
        )}
        {draft.discarded_by && (
          <span>
            discarded by {draft.discarded_by} · {stamp(draft.discarded_at)}
          </span>
        )}
        {draft.sent_at && <span>sent {stamp(draft.sent_at)}</span>}
      </div>

      {caseStatus !== "PROPOSED" && !decided && (
        <p className="rc-mono mt-4 text-[11px] text-[var(--rc-ink-faint)]">
          The case is {caseStatus}, so this draft can no longer be changed.
        </p>
      )}

      {caseStatus === "PROPOSED" && status === "pending" && (
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() =>
              onSave({
                recipient: recipient.trim(),
                subject: subject.trim(),
                body: body.trim(),
                revision: draft.revision,
              })
            }
            disabled={busy || !dirty || Boolean(rejection)}
            title={
              rejection ??
              (dirty
                ? "Store this text as the new revision"
                : "Nothing has changed yet")
            }
            className={`${BUTTON} border-[var(--rc-cyan)] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#04121a]`}
          >
            Save changes
          </button>
          <button
            type="button"
            onClick={() => onDecide("approve_draft", draft.revision)}
            // Unsaved edits must not be approved: approval names a revision, and the text in these
            // inputs is not yet any revision at all.
            disabled={busy || dirty || Boolean(rejection)}
            title={
              dirty
                ? "Save your changes first — an approval applies to a stored revision"
                : (rejection ??
                  "Approve this text for sending when the case is approved")
            }
            className={`${BUTTON} border-[var(--rc-green)] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f]`}
          >
            Approve draft
          </button>
          <button
            type="button"
            onClick={() => onDecide("discard_draft", draft.revision)}
            disabled={busy}
            title="This case will send no counterparty email. The draft is kept, read-only, as part of the record."
            className={`${BUTTON} border-[var(--rc-red)] text-[var(--rc-red)] hover:bg-[var(--rc-red)] hover:text-[#120404]`}
          >
            Discard draft
          </button>
        </div>
      )}

      {caseStatus === "PROPOSED" && status === "approved" && (
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <p
            className="rc-mono text-[12px]"
            style={{ color: "var(--rc-green)" }}
          >
            ◆ Armed at revision {draft.approved_revision} — this text is sent
            when you approve the case.
          </p>
          <button
            type="button"
            onClick={() => onDecide("revoke_draft", draft.revision)}
            disabled={busy}
            title="Withdraw the approval and reopen the text for editing. Nothing is sent until it is approved again."
            className={`${BUTTON} border-[var(--rc-ink-faint)] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)]`}
          >
            Revoke approval
          </button>
        </div>
      )}
    </Panel>
  );
}
