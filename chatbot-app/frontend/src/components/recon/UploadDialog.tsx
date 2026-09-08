"use client";

import { useEffect, useMemo, useState } from "react";

import { Panel } from "@/components/recon/ui";
import {
  listSkills,
  listWorkflowTypes,
  uploadFiles,
  type SkillType,
  type SubmissionFileRow,
  type WorkflowType,
} from "@/lib/reconApi";
import { ALLOWED_EXTENSIONS, uploadRejectionReason } from "@/lib/uploadPolicy";

// The closed set of break classes the seeded corpus uses. Held here as a literal, not fetched:
// these are the values the agent's own retrieval filters name, so a class that is not on this list
// is a document nothing will ever retrieve. Adding one means adding it to the corpus too.
const BREAK_CLASSES = [
  "timing",
  "tolerance",
  "aggregation",
  "missing_reference",
  "unknown",
] as const;

const LABEL =
  "rc-mono block text-[10px] uppercase tracking-[0.12em] text-[var(--rc-ink-faint)]";
const FIELD =
  "rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-2 text-[12px] text-[var(--rc-ink)]";

/**
 * Upload documents against a workflow type.
 *
 * The workflow type is the only routing decision the operator makes. Everything else the server
 * needs -- which bucket, which pinned extraction version, which knowledge-base document type -- is
 * read off the type they picked, because those combinations were already validated once when the
 * type was saved and re-asking here would let the operator contradict that.
 */
export function UploadDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [types, setTypes] = useState<WorkflowType[]>([]);
  const [skills, setSkills] = useState<SkillType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [breakClasses, setBreakClasses] = useState<string[]>([]);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SubmissionFileRow[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Retired types are filtered out here rather than server-side: the Config tab needs them all so
    // an operator can see what was retired, and this dialog is the one place that must not offer them.
    void listWorkflowTypes()
      .then((all) => setTypes(all.filter((t) => t.active)))
      .catch((e: unknown) => setError(String(e)));
    void listSkills()
      .then(setSkills)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const selected = useMemo(
    () => types.find((t) => t.workflow_type_id === typeId),
    [types, typeId],
  );

  // Shown next to each file before anything is sent, so the operator fixes a bad drag now rather
  // than reading a FAILED row afterwards. The route runs the identical check on its own.
  const localRejections = useMemo(
    () =>
      files.map((f) =>
        uploadRejectionReason({ filename: f.name, bytes: f.size }),
      ),
    [files],
  );

  const submit = async () => {
    if (!selected) {
      setError("pick a workflow type first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("route", selected.route);
      form.set("workflowTypeId", selected.workflow_type_id);
      form.set("configVersion", selected.idp_config_version);
      form.set("docType", selected.kb_doc_type);
      form.set("subject", subject);
      for (const c of breakClasses) form.append("breakClasses", c);
      for (const s of skillNames) form.append("skills", s);
      for (const f of files) form.append("files", f);

      const response = await uploadFiles(form);
      // Held on screen instead of closing. Some rows can be FAILED while others succeeded, and
      // closing on the way out would throw away the only place that difference is stated per file.
      setResults(response.files);
      onUploaded();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked =
    busy ||
    !selected ||
    files.length === 0 ||
    localRejections.some((r) => r !== null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload documents"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
    >
      <Panel className="w-full max-w-2xl space-y-4 p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="rc-display text-[22px] font-black text-[var(--rc-ink)]">
            Upload Documents
          </h2>
          <button
            onClick={onClose}
            className="rc-mono text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
          >
            Close
          </button>
        </div>

        {results ? (
          <ul className="space-y-2">
            {results.map((r) => (
              <li
                key={r.filename}
                className="rounded border border-[var(--rc-line)] p-3"
              >
                <span className="rc-mono block text-[12px] text-[var(--rc-ink)]">
                  {r.filename} — {r.status}
                </span>
                {r.derived_object_keys && r.derived_object_keys.length > 0 && (
                  <span className="rc-mono block text-[10px] text-[var(--rc-ink-faint)]">
                    became {r.derived_object_keys.length} document(s)
                  </span>
                )}
                {/* Verbatim. The reason came from the pre-processor or the policy check, and
                    rewording it here is how a specific message becomes "upload failed". */}
                {r.error && (
                  <span className="rc-mono block text-[10px] text-[var(--rc-amber)]">
                    {r.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            <label className="space-y-1">
              <span className={LABEL}>Workflow type</span>
              <select
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                className={FIELD}
              >
                <option value="">Select…</option>
                {types.map((t) => (
                  <option key={t.workflow_type_id} value={t.workflow_type_id}>
                    {t.display_name} ({t.route})
                  </option>
                ))}
              </select>
            </label>

            {/* Stated, not asked. This is the destination the chosen type implies, and showing it
                is what lets an operator notice they picked the wrong type before uploading. */}
            {selected && (
              <p className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">
                {selected.route === "extraction"
                  ? `Extracted as a structured notice against configuration ${selected.idp_config_version}.`
                  : `Ingested as knowledge-base guidance of type ${selected.kb_doc_type}. Searchable once the next ingestion job finishes, usually about a minute.`}
              </p>
            )}

            <label className="space-y-1">
              <span className={LABEL}>Files</span>
              <input
                type="file"
                multiple
                accept={ALLOWED_EXTENSIONS.join(",")}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className={FIELD}
              />
            </label>

            {files.length > 0 && (
              <ul className="space-y-1">
                {files.map((f, i) => (
                  <li key={f.name} className="rc-mono text-[11px]">
                    <span className="text-[var(--rc-ink)]">{f.name}</span>
                    {localRejections[i] && (
                      <span className="ml-2 text-[var(--rc-amber)]">
                        {localRejections[i]}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Only the knowledge-base route. These become the sidecar's filterable attributes, and
                the agent's retrieval filters name them: guidance tagged with no break class and no
                skill is indexed but unreachable, so both are asked for here. The extraction route
                has no equivalent -- the pinned configuration decides what is extracted. */}
            {selected?.route === "knowledge-base" && (
              <>
                <label className="space-y-1">
                  <span className={LABEL}>Break classes</span>
                  <select
                    multiple
                    size={5}
                    value={breakClasses}
                    onChange={(e) =>
                      setBreakClasses(
                        Array.from(e.target.selectedOptions, (o) => o.value),
                      )
                    }
                    className={FIELD}
                  >
                    {BREAK_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className={LABEL}>Skills</span>
                  {/* Read from the live catalog, not a literal: a skill name that does not exist is
                      a filter no Tier-1 classification will ever produce. */}
                  <select
                    multiple
                    size={5}
                    value={skillNames}
                    onChange={(e) =>
                      setSkillNames(
                        Array.from(e.target.selectedOptions, (o) => o.value),
                      )
                    }
                    className={FIELD}
                  >
                    {skills.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className={LABEL}>Subject (optional)</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className={FIELD}
                  />
                </label>
              </>
            )}
          </div>
        )}

        {error && (
          <p className="rc-mono text-[12px] text-[var(--rc-amber)]">{error}</p>
        )}

        <div className="flex justify-end gap-3">
          {results ? (
            <button
              onClick={onClose}
              className="rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#040a10]"
            >
              Done
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={blocked}
              className="rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#040a10] disabled:opacity-40"
            >
              {busy ? "Uploading…" : "Upload"}
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}
