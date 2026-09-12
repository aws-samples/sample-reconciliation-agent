"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

import {
  BTN_CONFIRM,
  Eyebrow,
  INPUT_CLASS,
  Notice,
  Panel,
  Placeholder,
  type ActionOutcome,
} from "./ui";

// The system-prompt page both apps mount over their own prompt route: a back link to the skills
// catalogue, an eyebrow, a title, one textarea over the prompt and Save. Recon mounts it for the
// workflow prompt both Tier-2 backends read; the pipeline for the parsing agent's prompt.
//
// What differs between the apps is passed in, never branched on: the two API calls, every line of text,
// and whether the object's key is shown. Every default is the recon page's: everyone may write (recon
// has no admin gate on the prompt), Save is offered as soon as the prompt is loaded whether or not it
// changed (`disableSaveWhenClean` is the pipeline's opt-in), no key is shown, and the box is the recon
// page's height. `readOnly` is the pipeline's non-admin viewer: textarea read-only, Save withheld.

export interface PromptEditorPageProps {
  /** Read the prompt. `{ content: "" }` is a valid answer — an unset prompt opens as an empty box. */
  load: () => Promise<{ content: string }>;
  /** Write the prompt as given, blank included. The route decides whether blank is acceptable. */
  save: (content: string) => Promise<unknown>;
  eyebrow: ReactNode;
  title: ReactNode;
  /** Where the back link goes: the app's skills catalogue. */
  backHref: string;
  backLabel?: ReactNode;
  /** The object key, shown beside the back link. Omitted: nothing shown. */
  path?: string;
  /** The confirmation line after a successful save. */
  savedMessage: string;
  /** The viewer may look but not change: textarea read-only, Save withheld. */
  readOnly?: boolean;
  /** Withhold Save while the box equals what was loaded or last saved. Off by default. */
  disableSaveWhenClean?: boolean;
  placeholder?: string;
  /** The textarea's accessible name. */
  textareaLabel?: string;
  loadingLabel?: ReactNode;
  /** Height classes for the textarea. */
  heightClass?: string;
}

export function PromptEditorPage({
  load,
  save,
  eyebrow,
  title,
  backHref,
  backLabel = "← Skills",
  path,
  savedMessage,
  readOnly = false,
  disableSaveWhenClean = false,
  placeholder,
  textareaLabel = "System prompt",
  loadingLabel = "◆ loading system prompt…",
  heightClass = "h-96",
}: PromptEditorPageProps) {
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Carries its tone: a refused S3 write must not read like "Saved".
  const [msg, setMsg] = useState<ActionOutcome | null>(null);

  // Loaded once, on mount. Kept in a ref so a caller passing a fresh `load` on every render — an inline
  // arrow, say — does not re-read the prompt over a half-typed edit.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    loadRef
      .current()
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const write = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await save(content ?? "");
      setSaved(content);
      setMsg({ tone: "success", text: savedMessage });
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveWithheld = busy || (disableSaveWhenClean && content === saved);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href={backHref}
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          {backLabel}
        </Link>
        {path && (
          <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
            {path}
          </span>
        )}
      </div>
      <header>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          {title}
        </h1>
      </header>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {error ? (
        <Placeholder kind="error">Failed to load — {error}</Placeholder>
      ) : content === null ? (
        <Placeholder kind="loading">{loadingLabel}</Placeholder>
      ) : (
        <Panel className="rc-rise p-5">
          <textarea
            aria-label={textareaLabel}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            placeholder={placeholder}
            className={`${INPUT_CLASS} w-full text-[13px] leading-relaxed ${heightClass}`}
          />
          {!readOnly && (
            <button
              type="button"
              onClick={write}
              disabled={saveWithheld}
              className={`${BTN_CONFIRM} mt-3`}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </Panel>
      )}
    </div>
  );
}
