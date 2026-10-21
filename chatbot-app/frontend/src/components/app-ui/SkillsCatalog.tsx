"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";

import { parseSkill } from "@/lib/skillFrontmatter";
import { ConfirmDeleteSkill, SkillEditor } from "./SkillEditor";
import {
  BTN_PRIMARY,
  Eyebrow,
  Notice,
  Panel,
  Placeholder,
  type ActionOutcome,
} from "./ui";

// The skills catalogue both apps mount over their own `/api/<app>/skills` routes: a header, a grid of
// tiles, "+ New skill", and one of two ways to open a skill.
//
//   - mode "inline" (recon): clicking a tile opens the skill IN PLACE, read-only, above the grid; its
//     "Edit ▸" — or the tile's own — turns that into the editor; Save writes, closes it, confirms and
//     reloads the grid; a tile's Delete asks, then deletes and reloads. Nothing navigates away.
//   - mode "route" (pipeline): tiles are links to `<basePath>/<name>`, where the app's detail page
//     mounts `SkillEditor`; "+ New skill" opens the editor for the template here and a create hands the
//     new name to `onCreated` for the page to navigate.
//
// What differs between the apps is passed in, never branched on: the five API calls, the header text
// and links, the template, what a tile's footer shows (recon's tools and model chips, the pipeline's
// object path), which names may not be deleted, who may write, and what an empty catalogue says. Every
// default is the recon page's: everyone may write (recon has no admin gate on skills), `unknown` has
// no Delete, the grid is drawn in the order the route answered, an empty catalogue is an empty grid.

/** The least a catalogue entry carries. An app's type may add to it (recon adds `tools` and `model`). */
export interface SkillsCatalogSkill {
  name: string;
  description: string;
}

/** The five calls the catalogue makes, bound by the caller to its own BFF client. */
export interface SkillsCatalogApi<S extends SkillsCatalogSkill> {
  listSkills(): Promise<S[]>;
  getSkill(name: string): Promise<{ name: string; content: string }>;
  createSkill(name: string, content: string): Promise<unknown>;
  saveSkill(name: string, content: string): Promise<unknown>;
  deleteSkill(name: string): Promise<unknown>;
}

export type SkillsCatalogMode = "inline" | "route";

export interface SkillsCatalogProps<S extends SkillsCatalogSkill> {
  api: SkillsCatalogApi<S>;
  mode: SkillsCatalogMode;
  /** Mode "route": tiles link to `${basePath}/${encodeURIComponent(name)}`. */
  basePath?: string;
  /** Mode "route": called with the new skill's name after a create, so the page can navigate to it. */
  onCreated?: (name: string) => void;
  /** The line over the title. */
  eyebrow: ReactNode;
  title?: ReactNode;
  /** The copy under the title: what a skill is here and when an edit takes effect. */
  description?: ReactNode;
  /** Links beside "+ New skill": the system prompt, the proposals queue. */
  headerActions?: ReactNode;
  /** The SKILL.md a new skill starts from. Its frontmatter `name:` is the name the create uses. */
  newTemplate: string;
  /** Whether the viewer may create, edit and delete. Default true: recon has no gate on skills. */
  canEdit?: boolean;
  /** Skills whose Delete is withheld. Default recon's `unknown`, the classification fallback. */
  protectedNames?: readonly string[];
  /** Drawn under each tile's description, above its actions. */
  tileFooter?: (skill: S) => ReactNode;
  /** Drawn instead of the grid when the catalogue is empty. Default: the empty grid. */
  emptyState?: ReactNode;
  /** The confirmation line after a save in mode "inline". */
  savedMessage?: string;
  /** The line under the delete confirmation's title. */
  deleteWarning?: ReactNode;
}

/** What is open above the grid in mode "inline", or the create panel in mode "route". */
interface Open {
  /** The skill, or null for a new one. */
  name: string | null;
  readOnly: boolean;
}

export function SkillsCatalog<S extends SkillsCatalogSkill>({
  api,
  mode,
  basePath = "",
  onCreated,
  eyebrow,
  title = "Skills",
  description,
  headerActions,
  newTemplate,
  canEdit = true,
  protectedNames = ["unknown"],
  tileFooter,
  emptyState,
  savedMessage = "Saved.",
  deleteWarning,
}: SkillsCatalogProps<S>) {
  const [skills, setSkills] = useState<S[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  /** The opened skill's content; null while loading; the template for a new skill. */
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ActionOutcome | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // The API is read through a ref so a caller passing a fresh object on every render — an inline
  // literal, say — does not reload the catalogue over an open editor. Loaded on mount and after a
  // write, and by nothing else.
  const apiRef = useRef(api);
  apiRef.current = api;
  const load = useCallback(
    () =>
      apiRef.current
        .listSkills()
        .then(setSkills)
        .catch((e) => setError(String(e))),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  /** Open one skill in place, read-only or for editing, loading its content. */
  const openSkill = async (name: string, readOnly: boolean) => {
    setMsg(null);
    setOpen({ name, readOnly });
    setContent(null);
    try {
      setContent((await api.getSkill(name)).content);
    } catch (e) {
      setContent("");
      setMsg({ tone: "error", text: String(e) });
    }
  };

  const openNew = () => {
    setMsg(null);
    setOpen({ name: null, readOnly: false });
    setContent(newTemplate);
  };

  const close = () => setOpen(null);

  const save = async (draft: string) => {
    if (!open) return;
    setBusy(true);
    setMsg(null);
    try {
      if (open.name === null) {
        // The name comes from the frontmatter, the same place the route's `validateSkill` reads it,
        // so the two cannot disagree.
        const name = parseSkill(draft).name;
        if (!name) throw new Error("frontmatter must include a name");
        await api.createSkill(name, draft);
        if (mode === "route" && onCreated) {
          onCreated(name);
          return;
        }
      } else {
        await api.saveSkill(open.name, draft);
      }
      setMsg({ tone: "success", text: savedMessage });
      setOpen(null);
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteSkill(name);
      if (open?.name === name) setOpen(null);
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const tileBody = (s: S, i: number) => (
    <div
      style={{ animationDelay: `${i * 50}ms` }}
      className="flex h-full flex-col"
    >
      <div className="flex items-start gap-2">
        <span className="mt-[6px] text-[var(--rc-cyan)]">▸</span>
        <span className="rc-mono text-[14px] font-medium text-[var(--rc-cyan)]">
          {s.name}
        </span>
      </div>
      <p className="mt-3 flex-1 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
        {s.description || "no description in the frontmatter"}
      </p>
      <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
        {tileFooter?.(s)}
        {mode === "inline" && canEdit && (
          <div className="mt-4 flex gap-4">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openSkill(s.name, false);
              }}
              className="rc-mono text-[11px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:opacity-80"
            >
              Edit ▸
            </button>
            {!protectedNames.includes(s.name) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(s.name);
                }}
                className="rc-mono text-[11px] uppercase tracking-[0.1em] text-[var(--rc-red)] hover:opacity-80"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        {/* min-w-0 + flex-1 lets this column consume the leftover header width so the description
            wraps at the viewport edge instead of a fixed max-width. basis-[320px] makes it drop to
            its own row before it gets too narrow. */}
        <div className="min-w-0 flex-1 basis-[320px]">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            {title}
          </h1>
          {description && (
            <p className="rc-mono mt-3 text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
              {description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          {headerActions}
          {canEdit && (
            <button type="button" onClick={openNew} className={BTN_PRIMARY}>
              + New skill
            </button>
          )}
        </div>
      </header>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {open && (
        <SkillEditor
          key={open.name ?? "__new__"}
          name={open.name}
          content={content}
          readOnly={open.readOnly}
          busy={busy}
          onSave={save}
          onClose={close}
          onEdit={
            open.readOnly && canEdit && open.name !== null
              ? () => setOpen({ name: open.name, readOnly: false })
              : undefined
          }
        />
      )}

      {error ? (
        <Placeholder kind="error">Failed to load skills — {error}</Placeholder>
      ) : !skills ? (
        <Placeholder kind="loading">◆ loading skills…</Placeholder>
      ) : skills.length === 0 && emptyState !== undefined ? (
        emptyState
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {skills.map((s, i) =>
            mode === "route" ? (
              <Link
                key={s.name}
                href={`${basePath}/${encodeURIComponent(s.name)}`}
                className="block"
              >
                <Panel
                  className="rc-rise flex h-full flex-col p-5 hover:border-[var(--rc-cyan)]"
                  title={`Open ${s.name}`}
                >
                  {tileBody(s, i)}
                </Panel>
              </Link>
            ) : (
              <Panel
                key={s.name}
                className="rc-rise flex cursor-pointer flex-col p-5 hover:border-[var(--rc-cyan)]"
                onClick={() => openSkill(s.name, true)}
                title={`View ${s.name} (read-only)`}
              >
                {tileBody(s, i)}
              </Panel>
            ),
          )}
        </div>
      )}

      {confirmDelete !== null && (
        <ConfirmDeleteSkill
          name={confirmDelete}
          warning={deleteWarning}
          busy={busy}
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
