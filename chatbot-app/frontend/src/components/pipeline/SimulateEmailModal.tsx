"use client";

import { useEffect, useState } from "react";
import { createEmail, listSamples } from "@/lib/pipelineApi";
import type { EmailRecord, SampleEmail } from "@/lib/pipeline/types";
import { formatDateTime, sourceLabel } from "@/components/pipeline/format";
import { BTN_PRIMARY, INPUT_CLASS, Modal, Placeholder } from "@/components/app-ui/ui";

// The demo's trigger. There is no mailbox integration in this phase, so "an email arrives" is a
// button: pick one of the fictional corpus samples, or paste any email. Both land in the same
// route and the same parser, which is the point — the corpus is a convenience, not a special path.

type Mode = "sample" | "paste";

/** Local wall-clock now, in the shape `<input type="datetime-local">` wants. */
function localNowForInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SimulateEmailModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Called with the new record (still RECEIVED); the caller navigates to it. */
  onCreated: (email: EmailRecord) => void;
}) {
  const [mode, setMode] = useState<Mode>("sample");
  const [samples, setSamples] = useState<SampleEmail[] | null>(null);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [raw, setRaw] = useState({
    from: "",
    subject: "",
    sent: localNowForInput(),
    body: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSamples()
      .then((s) => {
        setSamples(s);
        // Pre-select the first so the common path is two clicks: open, submit.
        if (s.length > 0) setSelected(s[0].id);
      })
      .catch((e) => setSamplesError(String(e)));
  }, []);

  const canSubmit =
    mode === "sample"
      ? selected !== null
      : raw.subject.trim() !== "" && raw.body.trim() !== "";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const email = await createEmail(
        mode === "sample"
          ? { sample_id: selected! }
          : {
              raw: {
                from: raw.from.trim() || "pasted@example.test",
                subject: raw.subject.trim(),
                body: raw.body,
                // The input gives local wall-clock time with no zone; ISO-8601 with the zone is what
                // the record stores and what Date Arrived is derived from.
                sent: new Date(raw.sent).toISOString(),
              },
            },
      );
      onCreated(email);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className="rc-mono rounded px-3 py-1 text-[11px] uppercase tracking-[0.08em]"
      style={{
        color: mode === m ? "var(--rc-ink)" : "var(--rc-ink-faint)",
        background: mode === m ? "var(--rc-panel-2)" : "transparent",
        border:
          mode === m ? "1px solid var(--rc-cyan)" : "1px solid var(--rc-line)",
      }}
    >
      {label}
    </button>
  );

  return (
    <Modal
      title="Simulate incoming email"
      subtitle="The email is stored as received and the parsing agent is invoked straight away. You will be taken to it so you can watch the status move."
      onClose={onClose}
      className="max-w-3xl"
    >
      <div className="flex gap-2">
        {tab("sample", "From the sample corpus")}
        {tab("paste", "Paste an email")}
      </div>

      {mode === "sample" ? (
        samplesError ? (
          <Placeholder kind="error">
            Could not load the samples — {samplesError}
          </Placeholder>
        ) : !samples ? (
          <Placeholder kind="loading">◆ loading samples…</Placeholder>
        ) : samples.length === 0 ? (
          <Placeholder kind="empty">
            ◇ no samples found — check SAMPLE_EMAILS_DIR
          </Placeholder>
        ) : (
          <div role="radiogroup" aria-label="Sample emails" className="space-y-2">
            {samples.map((s) => {
              const on = selected === s.id;
              return (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-start gap-3 rounded border px-3 py-2 hover:border-[var(--rc-cyan)]"
                  style={{
                    borderColor: on ? "var(--rc-cyan)" : "var(--rc-line)",
                    background: on ? "var(--rc-panel-2)" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="sample"
                    value={s.id}
                    checked={on}
                    onChange={() => setSelected(s.id)}
                    className="mt-1 h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-[var(--rc-ink)]">
                      {s.subject}
                    </span>
                    <span className="rc-mono mt-0.5 block text-[10.5px] text-[var(--rc-ink-faint)]">
                      {sourceLabel(s.source_kind)} · {formatDateTime(s.sent)} ·{" "}
                      {s.from}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="rc-eyebrow">From</span>
            <input
              value={raw.from}
              onChange={(e) => setRaw({ ...raw, from: e.target.value })}
              placeholder="Syndicate Desk <syndicate@example.test>"
              className={`${INPUT_CLASS} mt-1 w-full`}
            />
          </label>
          <label className="block">
            <span className="rc-eyebrow">Sent</span>
            <input
              type="datetime-local"
              value={raw.sent}
              onChange={(e) => setRaw({ ...raw, sent: e.target.value })}
              className={`${INPUT_CLASS} mt-1 w-full`}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="rc-eyebrow">Subject</span>
            <input
              value={raw.subject}
              onChange={(e) => setRaw({ ...raw, subject: e.target.value })}
              placeholder="Issuer - $500MM Term Loan B - Launch"
              className={`${INPUT_CLASS} mt-1 w-full`}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="rc-eyebrow">Body</span>
            <textarea
              value={raw.body}
              onChange={(e) => setRaw({ ...raw, body: e.target.value })}
              rows={12}
              spellCheck={false}
              placeholder="Paste the plain-text email here…"
              className={`${INPUT_CLASS} mt-1 w-full leading-relaxed`}
            />
          </label>
        </div>
      )}

      {error && (
        <p className="rc-mono text-[12px] text-[var(--rc-amber)]">{error}</p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !canSubmit}
          className={BTN_PRIMARY}
        >
          {busy ? "Sending…" : "Send to the inbox"}
        </button>
      </div>
    </Modal>
  );
}
