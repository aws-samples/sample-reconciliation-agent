"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createEmailTemplate,
  deactivateEmailTemplate,
  listEmailTemplates,
  updateEmailTemplate,
  type EmailTemplate,
} from "@/lib/reconApi";
import {
  Disclosure,
  Eyebrow,
  Modal,
  Panel,
  Placeholder,
} from "@/components/recon/ui";

// The wording the platform is allowed to send. An operator edits the subject and body here; the agent
// only chooses a template and supplies values for the declared variables, so this screen is where the
// tone and content of outbound mail is actually decided.
//
// Editing a template is safe for mail already out the door. A draft renders once, at draft time, and
// the rendered text is what gets persisted and what the gateway compares against — so a change here
// reaches the NEXT draft and never one already approved.
//
// The preview and the variable checks below are conveniences. `putTemplate` in the BFF and its Python
// counterpart both re-derive the placeholder set on save and refuse an undeclared one; this panel just
// says so before the round trip.

const INPUT =
  "rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-2 py-1.5 text-[12px] text-[var(--rc-ink)] disabled:opacity-50";
const BUTTON =
  "rc-mono rounded border px-3 py-1.5 text-[11px] uppercase tracking-[0.1em] transition-colors disabled:opacity-40";

const PURPOSES: { value: string; label: string }[] = [
  { value: "counterparty", label: "Counterparty" },
  { value: "internal_notification", label: "Internal notification" },
];

/**
 * Which `{{placeholders}}` a string contains, tolerating inner whitespace.
 *
 * The TypeScript twin of `placeholders_in` in `backend/recon_core/templating.py`, kept in step on the
 * one rule that matters: `{{ reference }}` with spaces is the placeholder `reference`. If this copy
 * were stricter it would warn about a template that renders perfectly well.
 */
function placeholdersIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of (text ?? "").matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g))
    found.add(m[1]);
  return [...found];
}

/**
 * Substitute `values` into `text` — for the on-screen preview ONLY.
 *
 * The same non-security posture `lib/emailPolicy.ts` documents at length: the text that actually gets
 * sent is rendered server-side by `render_template` from the stored row, never by this function. This
 * exists so an operator can see the shape of the sentence they are writing, with the braces filled in.
 */
function previewRender(text: string, values: Record<string, string>): string {
  return (text ?? "").replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
    (whole, name: string) => values[name] ?? whole,
  );
}

/** The fields of one template as they sit in the form, before any save. */
interface Draft {
  name: string;
  purpose: string;
  variables: string;
  subject_template: string;
  body_template: string;
}

function toDraft(t: EmailTemplate): Draft {
  return {
    name: t.name,
    purpose: t.purpose,
    variables: (t.variables ?? []).join(", "),
    subject_template: t.subject_template,
    body_template: t.body_template,
  };
}

const EMPTY: Draft = {
  name: "",
  purpose: "counterparty",
  variables: "",
  subject_template: "",
  body_template: "",
};

/** Split the comma-separated variables field the way the BFF route does. */
function declaredOf(variables: string): string[] {
  return variables
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** The human label for a stored purpose value, for the collapsed row. */
function purposeLabel(purpose: string): string {
  return PURPOSES.find((p) => p.value === purpose)?.label ?? purpose;
}

/**
 * The editor for one template, or for a new one when `template` is null.
 *
 * The editor is a form rather than a table row — a body template is a paragraph, and the preview needs
 * to sit under it where an operator can read both at once — but for a stored template it is collapsed
 * behind a single row. Every template being open at once meant a page of near-identical fields, and the
 * question an operator arrives with is "which wording do I want", which the row alone answers.
 *
 * The row label reads from the STORED template rather than the draft, so it does not shift under the
 * cursor while the name field is being typed. The draft stays mounted while collapsed, so collapsing a
 * row is not a way to silently lose an edit.
 *
 * `bare` drops the collapsible chrome, for the new-template case: that form is opened inside a dialog,
 * which is already its own container and already only shows one thing at a time.
 */
function TemplateForm({
  template,
  busy,
  bare = false,
  onSaved,
  onError,
}: {
  template: EmailTemplate | null;
  busy: boolean;
  /** Render the fields alone, without the surrounding collapsible row. */
  bare?: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    template ? toDraft(template) : EMPTY,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) setDraft(toDraft(template));
  }, [template]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const declared = declaredOf(draft.variables);
  const used = useMemo(
    () => [
      ...new Set([
        ...placeholdersIn(draft.subject_template),
        ...placeholdersIn(draft.body_template),
      ]),
    ],
    [draft.subject_template, draft.body_template],
  );
  const undeclared = used.filter((v) => !declared.includes(v));
  // Declared but never used is not an error — the agent simply passes a value nothing consumes — but
  // it is almost always a typo in one of the two templates, so it is worth saying.
  const unused = declared.filter((v) => !used.includes(v));

  // Preview values are the variable names in angle brackets, not invented sample data: the point is to
  // show where each value lands, and fake amounts would read as if the template were already filled.
  const previewValues = Object.fromEntries(
    declared.map((v) => [v, `<${v}>`]),
  ) as Record<string, string>;

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        purpose: draft.purpose,
        // The split happens here rather than server-side even though the route tolerates either shape:
        // this is the same list the placeholder warnings above were computed from, so submitting it
        // means the operator cannot be refused for a set they were never shown.
        variables: declared,
        subject_template: draft.subject_template,
        body_template: draft.body_template,
      };
      if (template) {
        await updateEmailTemplate(template.template_id, body);
        onSaved(`Saved ${body.name} (revision ${template.revision + 1}).`);
      } else {
        const created = await createEmailTemplate(body);
        setDraft(EMPTY);
        onSaved(`Added ${created.name}.`);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!template) return;
    setSaving(true);
    try {
      await deactivateEmailTemplate(template.template_id);
      onSaved(
        `${template.name} deactivated — no new draft can use it; existing cases keep the text they already rendered.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = busy || saving;
  const incomplete =
    !draft.name.trim() ||
    !draft.subject_template.trim() ||
    !draft.body_template.trim();

  // Rendered above the fields on a stored template (where it sits directly under the row you just
  // opened) and below them in the dialog (where "create" is the last thing you reach for).
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={save}
        disabled={disabled || incomplete || undeclared.length > 0}
        title={
          undeclared.length > 0
            ? "Declare every placeholder first, or the send would go out with literal braces in it"
            : "Store this wording"
        }
        className={`${BUTTON} border-[var(--rc-cyan)] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#04121a]`}
      >
        {template ? "Save" : saving ? "Creating…" : "Create template"}
      </button>
      {template && template.active && (
        <button
          type="button"
          onClick={remove}
          disabled={disabled}
          title="Stops new drafts from using this wording. Cases already drafted from it are unaffected — they hold their own rendered copy."
          className={`${BUTTON} border-[var(--rc-red)] text-[var(--rc-red)] hover:bg-[var(--rc-red)] hover:text-[#120404]`}
        >
          Deactivate
        </button>
      )}
    </div>
  );

  const fields = (
    <>
      {!bare && actions}

      <div className={`grid gap-3 md:grid-cols-3 ${bare ? "" : "mt-3"}`}>
        <label className="block">
          <span className="rc-eyebrow">Name</span>
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            disabled={disabled}
            placeholder="Ask for a payment reference"
            className={`${INPUT} mt-1`}
          />
        </label>
        <label className="block">
          <span className="rc-eyebrow">Purpose</span>
          <select
            value={draft.purpose}
            onChange={(e) => set({ purpose: e.target.value })}
            disabled={disabled}
            className={`${INPUT} mt-1`}
          >
            {PURPOSES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="rc-eyebrow">Variables (comma separated)</span>
          <input
            value={draft.variables}
            onChange={(e) => set({ variables: e.target.value })}
            disabled={disabled}
            placeholder="reference, amount, value_date"
            className={`${INPUT} mt-1`}
          />
        </label>
      </div>

      <label className="mt-3 block">
        <span className="rc-eyebrow">Subject</span>
        <input
          value={draft.subject_template}
          onChange={(e) => set({ subject_template: e.target.value })}
          disabled={disabled}
          placeholder="Unapplied receipt {{reference}}"
          className={`${INPUT} mt-1`}
        />
      </label>

      <label className="mt-3 block">
        <span className="rc-eyebrow">Body</span>
        <textarea
          value={draft.body_template}
          onChange={(e) => set({ body_template: e.target.value })}
          disabled={disabled}
          rows={5}
          placeholder="We received {{amount}} on {{value_date}} without a reference. Could you confirm which invoice it settles?"
          className={`${INPUT} mt-1 leading-relaxed`}
        />
      </label>

      {undeclared.length > 0 && (
        <p
          className="rc-mono mt-3 text-[12px]"
          style={{ color: "var(--rc-amber)" }}
        >
          {undeclared.join(", ")} {undeclared.length === 1 ? "is" : "are"} used
          but not declared. An undeclared placeholder is not substituted — it
          would reach the recipient as literal {"{{braces}}"}. Add it to
          Variables, or remove it from the text.
        </p>
      )}
      {unused.length > 0 && (
        <p className="rc-mono mt-2 text-[12px] text-[var(--rc-ink-faint)]">
          {unused.join(", ")} declared but never used — harmless, but probably a
          typo.
        </p>
      )}

      {/* Preview. Labelled as one, because it is rendered here in the browser and the send is not. */}
      <div className="mt-4 rounded border border-dashed border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3">
        <span className="rc-eyebrow">
          Preview — rendered in this browser, not the text that will be sent
        </span>
        <p className="rc-mono mt-2 text-[12px] text-[var(--rc-ink)]">
          {previewRender(draft.subject_template, previewValues) || (
            <span className="text-[var(--rc-ink-faint)]">(no subject yet)</span>
          )}
        </p>
        <p className="rc-mono mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
          {previewRender(draft.body_template, previewValues) || "(no body yet)"}
        </p>
      </div>

      {bare && <div className="mt-4">{actions}</div>}
    </>
  );

  if (bare) return fields;

  return (
    <Disclosure
      // Kept mounted while collapsed so a half-written edit survives a click on its own row.
      keepMounted
      summary={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
            {template ? template.name : "New template"}
          </span>
          <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
            {template
              ? `${template.template_id} · rev ${template.revision}`
              : "write a new wording the agent may draft from"}
          </span>
        </span>
      }
      meta={
        template
          ? `${purposeLabel(template.purpose)}${template.active ? "" : " · inactive"}`
          : undefined
      }
      style={{ opacity: template && !template.active ? 0.55 : 1 }}
    >
      <div className="p-4">{fields}</div>
    </Disclosure>
  );
}

export function TemplatesPanel() {
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new template is written in a dialog. Inline it was a permanently empty editor at the foot of the
  // list, indistinguishable at a glance from a real template whose wording someone had cleared out.
  const [adding, setAdding] = useState(false);

  const reload = async () => {
    try {
      setTemplates(await listEmailTemplates());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const report = (message: string) => {
    setMsg(message);
    setError(null);
    void reload();
  };
  const fail = (message: string) => {
    setError(message);
    setMsg(null);
  };

  return (
    <Panel className="rc-rise p-6">
      <div className="max-w-2xl">
        <Eyebrow title="The agent chooses a template and supplies values for its declared variables. It cannot compose free text: wording that is not on this list cannot be sent.">
          Email templates
        </Eyebrow>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
          The wording available to the platform. A draft is rendered from one of
          these at the moment it is created and the rendered text is what gets
          reviewed and sent, so edits here change the next draft and leave
          approved ones exactly as an analyst read them.
        </p>
      </div>

      <div className="mt-5 space-y-4">
        {loadError ? (
          <Placeholder kind="error">
            Failed to load templates — {loadError}
          </Placeholder>
        ) : templates === null ? (
          <Placeholder kind="loading">◆ loading templates…</Placeholder>
        ) : (
          <>
            {templates.length === 0 && (
              <Placeholder kind="empty">
                No templates yet. Until one exists the agent has nothing to
                draft from.
              </Placeholder>
            )}
            {templates.map((t) => (
              <TemplateForm
                key={`${t.template_id}:${t.revision}`}
                template={t}
                busy={false}
                onSaved={report}
                onError={fail}
              />
            ))}
          </>
        )}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${BUTTON} border-[var(--rc-green)] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f]`}
        >
          Add new template
        </button>
      </div>

      {adding && (
        <Modal
          title="Add New Email Template"
          subtitle="Available to the agent as soon as it is created. It cannot compose free text, so this wording is what will actually be sent — read the preview before creating."
          onClose={() => setAdding(false)}
          className="max-w-3xl"
        >
          <TemplateForm
            template={null}
            busy={false}
            bare
            // Closing on success, so the dialog does not sit there with the wording still in it looking
            // like nothing happened. A failure leaves it open with the text intact to fix.
            onSaved={(message) => {
              setAdding(false);
              report(message);
            }}
            onError={fail}
          />
        </Modal>
      )}

      {msg && (
        <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">{msg}</p>
      )}
      {error && (
        <p
          className="rc-mono mt-4 text-[12px]"
          style={{ color: "var(--rc-amber)" }}
        >
          {error}
        </p>
      )}
    </Panel>
  );
}
