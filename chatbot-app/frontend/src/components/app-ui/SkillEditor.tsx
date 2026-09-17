"use client";

import { useState, type ReactNode } from "react";

import {
  BTN_CONFIRM,
  BTN_DANGER,
  BTN_LINK,
  BTN_PRIMARY,
  Eyebrow,
  INPUT_CLASS,
  Modal,
  Panel,
  Placeholder,
} from "./ui";

// The SKILL.md editor both apps mount: one textarea over one skill's markdown, with Save, an optional
// Cancel/Close, an optional confirmed Delete, and a read-only view that offers to switch to editing.
// The recon Skills page mounts it IN the catalogue page (`SkillsCatalog` mode "inline") for the skill
// whose tile was clicked; the pipeline's `skills/[name]` page mounts it as the body of a detail route.
//
// The editor owns only the draft. The caller owns the saved content (`content`), the in-flight flag
// and the outcome line, because a page has one `busy` for every control on it and its own wording for
// a success; `onSave` is handed the draft and the caller writes. Dirty tracking compares the draft
// with `content`, so a caller that sets `content` to the draft after a successful write makes the
// editor clean again without the editor knowing a write happened.
//
// Every default is the recon editor's: Save is offered as soon as the skill is loaded, changed or not
// (`disableSaveWhenClean` is the pipeline's opt-in); the eyebrow names what is open; the box is the
// recon editor's height. `readOnly` covers both apps' read-only states — recon's "click a tile to view"
// and the pipeline's non-admin viewer — and hides every write control.

export interface SkillEditorProps {
  /** The skill being edited, or null for a new one. Names the eyebrow and the delete confirmation. */
  name: string | null;
  /**
   * The content as last loaded or saved — the baseline the draft is compared against. `null` while it
   * is still loading: the panel shows a loading placeholder in place of the textarea.
   */
  content: string | null;
  /** The viewer may look but not change: textarea read-only, Save and Delete withheld, "Edit ▸" offered. */
  readOnly?: boolean;
  /** A write is in flight somewhere on the page: every control disabled. */
  busy?: boolean;
  /** Withhold Save while the draft equals `content`. Off by default: recon saves whatever is in the box. */
  disableSaveWhenClean?: boolean;
  /** Called with the draft. The caller writes and, on success, passes the new `content`. */
  onSave: (draft: string) => void | Promise<void>;
  /** Cancel (editing) or Close (read-only). Omitted: no such button — a detail route has a back link. */
  onClose?: () => void;
  /** Read-only only: "Edit ▸" switches the caller to editing. */
  onEdit?: () => void;
  /** Delete, after confirmation. Omitted: no Delete — a new skill, a protected one, or no permission. */
  onDelete?: () => void | Promise<void>;
  /** The line under the delete confirmation's title: what deleting means for this app's agent. */
  deleteWarning?: ReactNode;
  /**
   * Replaces the computed eyebrow — "New skill (SKILL.md)", "Editing <name>" or
   * "Viewing <name> · read-only". `null` hides it, for a page whose header already names the skill.
   */
  eyebrow?: ReactNode | null;
  /** The textarea's accessible name. */
  textareaLabel?: string;
  /** Height classes for the textarea. */
  heightClass?: string;
}

function computedEyebrow(name: string | null, readOnly: boolean): ReactNode {
  if (name === null) return "New skill (SKILL.md)";
  return readOnly ? `Viewing ${name} · read-only` : `Editing ${name}`;
}

/**
 * The delete confirmation both the editor and the catalogue's tiles open.
 *
 * @param name the skill named in the title.
 * @param warning the line under the title.
 */
export function ConfirmDeleteSkill({
  name,
  warning,
  busy = false,
  onConfirm,
  onCancel,
}: {
  name: string;
  warning?: ReactNode;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={`Delete skill "${name}"?`}
      subtitle={warning}
      onClose={onCancel}
      className="max-w-xl"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={BTN_DANGER}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={BTN_LINK}
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}

export function SkillEditor({
  name,
  content,
  readOnly = false,
  busy = false,
  disableSaveWhenClean = false,
  onSave,
  onClose,
  onEdit,
  onDelete,
  deleteWarning,
  eyebrow,
  textareaLabel = "Skill content",
  heightClass = "h-80",
}: SkillEditorProps) {
  // `null` means untouched: the box mirrors `content`, including when it arrives after mount. Set on
  // the first keystroke, and compared with `content` for dirtiness from then on.
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const value = draft ?? content ?? "";
  const dirty = draft !== null && draft !== content;
  const saveWithheld = busy || (disableSaveWhenClean && !dirty);
  const heading =
    eyebrow === undefined ? computedEyebrow(name, readOnly) : eyebrow;

  const remove = async () => {
    try {
      await onDelete?.();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Panel className="rc-rise p-5">
      {(heading !== null || (readOnly && (onEdit || onClose))) && (
        <div className="flex items-center justify-between gap-3">
          {heading !== null ? <Eyebrow>{heading}</Eyebrow> : <span />}
          {readOnly && (onEdit || onClose) && (
            <div className="flex gap-3">
              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  disabled={busy}
                  className={BTN_PRIMARY}
                >
                  Edit ▸
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className={BTN_LINK}
                >
                  Close
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {content === null ? (
        <Placeholder kind="loading">◆ loading {name ?? "skill"}…</Placeholder>
      ) : (
        <textarea
          aria-label={textareaLabel}
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={readOnly}
          spellCheck={false}
          className={`${INPUT_CLASS} mt-3 w-full leading-relaxed ${heightClass}`}
        />
      )}

      {!readOnly && content !== null && (
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={() => onSave(value)}
            disabled={saveWithheld}
            className={BTN_CONFIRM}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className={BTN_LINK}
            >
              Cancel
            </button>
          )}
          {onDelete && name !== null && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy}
              className={`${BTN_DANGER} ml-auto`}
            >
              Delete
            </button>
          )}
        </div>
      )}

      {confirming && name !== null && (
        <ConfirmDeleteSkill
          name={name}
          warning={deleteWarning}
          busy={busy}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Panel>
  );
}
