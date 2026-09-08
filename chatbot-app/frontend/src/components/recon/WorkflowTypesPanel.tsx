"use client";

import { useEffect, useState } from "react";
import {
  createWorkflowType,
  deactivateWorkflowType,
  listWorkflowTypes,
  updateWorkflowType,
  type WorkflowType,
} from "@/lib/reconApi";
import { Eyebrow, Modal, Panel, Placeholder } from "@/components/recon/ui";

// The categories of document an operator may upload, and where each category goes.
//
// The route is shown on every row rather than inferred from which of the two adjacent fields happens
// to be filled in. That is the whole design of this panel: "this type is not extracted" has to be a
// visible property of the type, because the failure it prevents is silent. An extraction type saved
// with no version pinned does not fail anywhere downstream — the document pipeline resolves whichever
// configuration is active at that moment — so nobody would ever be told.
//
// Nothing here authorizes anything. The BFF re-validates every row and refuses the incoherent ones;
// these messages exist to save an operator a round trip.

const INPUT =
  "rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-2 py-1.5 text-[12px] text-[var(--rc-ink)] disabled:opacity-50";
const BUTTON =
  "rc-mono rounded border px-3 py-1.5 text-[11px] uppercase tracking-[0.1em] transition-colors disabled:opacity-40";

const ROUTES: { value: string; label: string; hint: string }[] = [
  {
    value: "extraction",
    label: "Extraction",
    hint: "the document is read into a structured notice against a pinned configuration version",
  },
  {
    value: "knowledge-base",
    label: "Knowledge base",
    hint: "the document is ingested as guidance the agent can retrieve during an investigation",
  },
];

const KB_DOC_TYPES = ["email", "email_attachment"] as const;

/**
 * Turn a display name into the id the row is stored under.
 *
 * The id is a separate field because it is permanent — every document ever uploaded under a type
 * references it — while the display name is free to be reworded. Deriving it from the name means the
 * common case needs no second thought, and the field stays editable for the case where it does.
 */
function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One editable row. Local state per row so an edit in progress survives a sibling's save. */
function WorkflowTypeRow({
  workflowType,
  busy,
  onSaved,
  onError,
}: {
  workflowType: WorkflowType;
  busy: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(workflowType.display_name);
  const [route, setRoute] = useState<string>(workflowType.route);
  const [version, setVersion] = useState(workflowType.idp_config_version ?? "");
  const [docType, setDocType] = useState(workflowType.kb_doc_type ?? "");
  const [saving, setSaving] = useState(false);

  // Re-sync when the list reloads under us, so this row stops showing values that another operator's
  // change has already replaced.
  useEffect(() => {
    setName(workflowType.display_name);
    setRoute(workflowType.route);
    setVersion(workflowType.idp_config_version ?? "");
    setDocType(workflowType.kb_doc_type ?? "");
  }, [
    workflowType.display_name,
    workflowType.route,
    workflowType.idp_config_version,
    workflowType.kb_doc_type,
  ]);

  const isExtraction = route === "extraction";
  const dirty =
    name !== workflowType.display_name ||
    route !== workflowType.route ||
    version !== (workflowType.idp_config_version ?? "") ||
    docType !== (workflowType.kb_doc_type ?? "");

  const save = async () => {
    setSaving(true);
    try {
      // The field that does not belong to the chosen route is sent as empty rather than left as-is.
      // Otherwise switching a type from extraction to knowledge base carries the old version along,
      // and the server refuses the save with a message about a field the operator cannot see.
      await updateWorkflowType(workflowType.workflow_type_id, {
        display_name: name.trim(),
        route,
        idp_config_version: isExtraction ? version.trim() : "",
        kb_doc_type: isExtraction ? "" : docType,
      });
      onSaved(`Saved ${name.trim()}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (active: boolean) => {
    setSaving(true);
    try {
      if (active) {
        await updateWorkflowType(workflowType.workflow_type_id, {
          active: true,
        });
        onSaved(`${workflowType.display_name} is offered for upload again.`);
      } else {
        await deactivateWorkflowType(workflowType.workflow_type_id);
        onSaved(
          `${workflowType.display_name} retired — it is no longer offered for upload. Documents already processed under it are unaffected.`,
        );
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = busy || saving;

  return (
    // Every cell is top-aligned. The name cell is taller than its siblings because the id caption sits
    // under its input, and with the default middle alignment that extra height pushed the name input
    // above the route and version controls beside it — three fields on one row, none of them level.
    <tr
      className="border-t border-[var(--rc-line)] [&>td]:align-top"
      style={{ opacity: workflowType.active ? 1 : 0.55 }}
    >
      <td className="py-2 pr-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          aria-label={`Display name for ${workflowType.workflow_type_id}`}
          className={INPUT}
        />
        <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
          {workflowType.workflow_type_id}
        </span>
      </td>
      <td className="py-2 pr-3">
        <select
          value={route}
          onChange={(e) => setRoute(e.target.value)}
          disabled={disabled}
          aria-label={`Route for ${workflowType.workflow_type_id}`}
          className={INPUT}
        >
          {ROUTES.map((r) => (
            <option key={r.value} value={r.value} title={r.hint}>
              {r.label}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">
        {isExtraction ? (
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            disabled={disabled}
            placeholder="configuration version name"
            aria-label={`Configuration version for ${workflowType.workflow_type_id}`}
            className={INPUT}
          />
        ) : (
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            disabled={disabled}
            aria-label={`Knowledge-base facet for ${workflowType.workflow_type_id}`}
            className={INPUT}
          >
            <option value="">choose a facet…</option>
            {KB_DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="py-2 pr-3">
        <span
          // The pill is shorter than the inputs beside it, so a top-aligned cell would leave it riding
          // high; this drops it onto their centre line.
          className="rc-pill mt-1"
          style={{
            color: workflowType.active
              ? "var(--rc-green)"
              : "var(--rc-ink-faint)",
          }}
        >
          {workflowType.active ? "active" : "retired"}
        </span>
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={disabled || !dirty}
            title={dirty ? "Store these values" : "Nothing has changed yet"}
            className={`${BUTTON} border-[var(--rc-cyan)] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#04121a]`}
          >
            Save
          </button>
          {workflowType.active ? (
            <button
              type="button"
              onClick={() => setActive(false)}
              disabled={disabled}
              title="Takes this type out of the upload picker. The row is kept, so documents already uploaded under it still record which configuration processed them."
              className={`${BUTTON} border-[var(--rc-red)] text-[var(--rc-red)] hover:bg-[var(--rc-red)] hover:text-[#120404]`}
            >
              Retire
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActive(true)}
              disabled={disabled}
              title="Offer this type for upload again"
              className={`${BUTTON} border-[var(--rc-ink-faint)] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)]`}
            >
              Restore
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function WorkflowTypesPanel() {
  const [types, setTypes] = useState<WorkflowType[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The create form lives in a dialog. Inline, it was a permanently empty row under the real ones, and
  // its placeholders read as saved values — the two fields in the name column looked like a duplicate
  // of the extraction field beside them.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRoute, setNewRoute] = useState("extraction");
  const [newVersion, setNewVersion] = useState("");
  const [newDocType, setNewDocType] = useState("");

  // The id follows the name until an operator types in the id field themselves, after which it is
  // theirs and this stops overwriting it.
  const [newIdOverride, setNewIdOverride] = useState<string | null>(null);
  const newId = newIdOverride ?? slugify(newName);

  const reload = async () => {
    try {
      setTypes(await listWorkflowTypes());
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

  const newIsExtraction = newRoute === "extraction";

  const add = async () => {
    setBusy(true);
    try {
      const created = await createWorkflowType({
        workflow_type_id: newId.trim(),
        display_name: newName.trim(),
        route: newRoute,
        idp_config_version: newIsExtraction ? newVersion.trim() : "",
        kb_doc_type: newIsExtraction ? "" : newDocType,
      });
      setNewName("");
      setNewIdOverride(null);
      setNewVersion("");
      setNewDocType("");
      setAdding(false);
      report(`Added ${created.display_name}.`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Which fields are still empty, named the way the operator sees them. A disabled button that does
  // nothing on click reads as broken, so the reason is rendered next to it rather than left in a
  // tooltip nobody hovers.
  const missing: string[] = [];
  if (newName.trim() === "") missing.push("a name");
  if (newId.trim() === "") missing.push("an id");
  if (newIsExtraction) {
    if (newVersion.trim() === "") missing.push("a configuration version");
  } else if (newDocType === "") {
    missing.push("a facet");
  }
  const addable = missing.length === 0;

  return (
    <Panel className="rc-rise p-6">
      <div className="max-w-2xl">
        <Eyebrow title="A workflow type is what an operator picks when uploading a document. Its route decides where the document goes, and the route is stored rather than inferred.">
          Workflow types
        </Eyebrow>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
          What may be uploaded, and where each kind of upload goes.{" "}
          <strong>Extraction</strong> types are read into structured notices
          against the configuration version pinned here.{" "}
          <strong>Knowledge base</strong> types are ingested as guidance the
          agent retrieves while investigating, and are never turned into notice
          rows. A type is one or the other; the two sets of fields are mutually
          exclusive and a row claiming both is refused.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
          The configuration version is typed rather than picked from a list.
          This platform has no way to read the document pipeline&apos;s version
          names — that API refuses a machine caller — so the name is copied in
          by hand. A typo does not fail the upload: it shows up as a
          disagreement between the version pinned here and the version the
          pipeline reports on the Documents tab, one hop later.
        </p>
      </div>

      <div className="mt-5">
        {loadError ? (
          <Placeholder kind="error">
            Failed to load workflow types — {loadError}
          </Placeholder>
        ) : types === null ? (
          <Placeholder kind="loading">◆ loading workflow types…</Placeholder>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="rc-eyebrow">
                <th className="w-[28%] pb-2 pr-3">Name</th>
                <th className="w-[18%] pb-2 pr-3">Route</th>
                <th className="w-[26%] pb-2 pr-3">Version / facet</th>
                <th className="w-[10%] pb-2 pr-3">State</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {types.length === 0 && (
                <tr className="border-t border-[var(--rc-line)]">
                  <td
                    colSpan={5}
                    className="rc-mono py-4 text-[12px] text-[var(--rc-ink-faint)]"
                  >
                    No workflow types yet. Until one exists there is nothing to
                    upload against.
                  </td>
                </tr>
              )}
              {types.map((t) => (
                <WorkflowTypeRow
                  key={t.workflow_type_id}
                  workflowType={t}
                  busy={busy}
                  onSaved={report}
                  onError={fail}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${BUTTON} border-[var(--rc-green)] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f]`}
        >
          Add new type
        </button>
      </div>

      {adding && (
        <Modal
          title="Add New Workflow Type"
          subtitle="Offered in the upload picker as soon as it is created. Nothing is uploaded here — this only declares that the kind of document exists and where it goes."
          onClose={() => setAdding(false)}
        >
          <label className="block">
            <span className="rc-eyebrow">Name</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
              placeholder="Unapplied cash notice"
              aria-label="New workflow type display name"
              className={`${INPUT} mt-1`}
            />
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              What an operator sees in the upload picker. This can be reworded
              later.
            </span>
          </label>

          <label className="block">
            <span className="rc-eyebrow">Id</span>
            <input
              value={newId}
              onChange={(e) => setNewIdOverride(e.target.value)}
              disabled={busy}
              placeholder="unapplied-cash-notice"
              aria-label="New workflow type id"
              className={`${INPUT} mt-1`}
            />
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              Permanent — every document uploaded under this type references it,
              and it cannot be changed afterwards. Follows the name above until
              you edit it here.
            </span>
          </label>

          <label className="block">
            <span className="rc-eyebrow">Route</span>
            <select
              value={newRoute}
              onChange={(e) => setNewRoute(e.target.value)}
              disabled={busy}
              aria-label="New workflow type route"
              className={`${INPUT} mt-1`}
            >
              {ROUTES.map((r) => (
                <option key={r.value} value={r.value} title={r.hint}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              {ROUTES.find((r) => r.value === newRoute)?.hint}
            </span>
          </label>

          {/* One field or the other, never both — which is the rule the server enforces on save. */}
          <label className="block">
            <span className="rc-eyebrow">
              {newIsExtraction
                ? "Configuration version"
                : "Knowledge-base facet"}
            </span>
            {newIsExtraction ? (
              <input
                value={newVersion}
                onChange={(e) => setNewVersion(e.target.value)}
                disabled={busy}
                placeholder="configuration version name"
                aria-label="New workflow type configuration version"
                className={`${INPUT} mt-1`}
              />
            ) : (
              <select
                value={newDocType}
                onChange={(e) => setNewDocType(e.target.value)}
                disabled={busy}
                aria-label="New workflow type knowledge-base facet"
                className={`${INPUT} mt-1`}
              >
                <option value="">choose a facet…</option>
                {KB_DOC_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              {newIsExtraction
                ? "Typed by hand — this platform cannot read the document pipeline's version names. A typo does not fail the upload; it surfaces as a disagreement on the Documents tab."
                : "Which facet the ingested guidance is filed under."}
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {/* The reason is rendered, not left in a tooltip: a disabled button that does nothing on
                click reads as broken. */}
            {!addable && (
              <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
                still needs {missing.join(", ")}
              </span>
            )}
            <button
              type="button"
              onClick={add}
              disabled={busy || !addable}
              className={`${BUTTON} border-[var(--rc-green)] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f]`}
            >
              {busy ? "Creating…" : "Create type"}
            </button>
          </div>
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
