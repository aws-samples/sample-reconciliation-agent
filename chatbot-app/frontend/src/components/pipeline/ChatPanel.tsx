"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getChatHistory,
  streamChat,
  type ChatRequest,
} from "@/lib/pipelineApi";
import type { ChatMessage, ChatStreamEvent } from "@/lib/pipeline/types";
import { MarkdownLite } from "@/components/pipeline/markdownLite";
import { formatDateTime } from "@/components/pipeline/format";
import {
  BTN_LINK,
  BTN_PRIMARY,
  BTN_QUIET,
  Eyebrow,
  INPUT_CLASS,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";

// The conversation with the assistant. The session id lives in sessionStorage so a reload keeps the
// thread (the BFF rebuilds the transcript from the short-term chat memory) while a new tab starts
// clean. Tool calls are shown inline under the turn that made them, because "I read the deal, then
// the skill, then proposed a change" is the part of the answer a reviewer needs to trust it.

const SESSION_KEY = "pipeline:chat:session";

/** Tool activity under an assistant turn; `pending` while the call is in flight. */
interface ToolChip {
  name: string;
  ok: boolean;
  summary: string;
  pending?: boolean;
}

/** A transcript entry as rendered. `error` is a stream failure attached to the turn it interrupted. */
type UiMessage = Omit<ChatMessage, "tools"> & {
  tools?: ToolChip[];
  error?: string;
};

const STARTERS = [
  "Which deals failed their OMS upload, and why?",
  "What did the parser assume on the most recent deal?",
  "Summarise the rules currently in memory.",
];

/**
 * Whether a tool result says the BFF refused a write because the caller is not in the admin group.
 *
 * The refusal arrives as an ordinary `tool_result` — the model asked, the server said no — so the chip
 * cannot rely on the `ok` flag alone to say "nothing happened". Matching the server's wording is what
 * lets a non-admin see, in the error colour and in words, why the memory did not change.
 */
function isAdminRefusal(summary: string): boolean {
  return /requires the admin group/i.test(summary);
}

/**
 * An unguessable id for one tab's chat session.
 *
 * Both branches draw from the platform CSPRNG. The fallback existed for `crypto.randomUUID`, which
 * needs a secure context, and it used to reach for `Math.random()` — flagged by CodeQL
 * (`js/insecure-randomness`, alert 9) and correctly: the generator is seeded from the clock, so ids
 * minted on an insecure origin were largely predictable from their own timestamp. `getRandomValues`
 * has no such requirement, so the weak branch bought nothing.
 *
 * Reading another person's transcript never depended on this: `GET /chat/history` verifies the
 * caller and passes their actor to `ListEvents` beside the session id, so a guessed id lists
 * nothing. Unguessable ids are the second line of that defence, not the first.
 *
 * The output satisfies `SESSION_ID` (`lib/pipeline/server/requests.ts`, `[A-Za-z0-9_-]{1,100}`),
 * which is also the character set the memory API accepts for a session id — hence hex rather than
 * base64url, whose padding the pattern would reject.
 */
function newSessionId(): string {
  // Read once into a typed local: `"randomUUID" in crypto` narrows the global to `never` on the
  // else branch, which would hide `getRandomValues` from the fallback below.
  const webCrypto: Crypto | undefined =
    typeof crypto === "undefined" ? undefined : crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = webCrypto!.getRandomValues(new Uint8Array(16));
  return `s-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The stored session id, creating one when the tab has none. */
function loadSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh = newSessionId();
    window.sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    // Storage denied: the session lives for this render only, which still works.
    return newSessionId();
  }
}

export function ChatPanel({
  context,
  onTurnComplete,
}: {
  /** The deal or email the conversation is about, from the page's query string. */
  context?: ChatRequest["context"];
  /** Fired after each completed assistant turn, so the memory panel beside this one can refresh. */
  onTurnComplete?: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Resolve the session on the client only: sessionStorage does not exist during server rendering.
  useEffect(() => {
    setSessionId(loadSessionId());
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    setMessages(null);
    setHistoryError(null);
    getChatHistory(sessionId)
      .then((h) => {
        if (live) setMessages(h);
      })
      .catch((e) => {
        // A missing history is not a broken chat: start empty and say why.
        if (live) {
          setMessages([]);
          setHistoryError(String(e));
        }
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  /** Apply one stream event to the assistant turn at the end of the transcript. */
  const applyEvent = useCallback((event: ChatStreamEvent) => {
    setMessages((prev) => {
      if (!prev || prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1] };
      if (last.role !== "assistant") return prev;
      switch (event.type) {
        case "text":
          last.content += event.delta;
          break;
        case "tool_call":
          last.tools = [
            ...(last.tools ?? []),
            { name: event.name, ok: true, summary: "running…", pending: true },
          ];
          break;
        case "tool_result": {
          const tools = [...(last.tools ?? [])];
          // Resolve the earliest still-pending call of that name: tool calls complete in order.
          const idx = tools.findIndex(
            (t) => t.pending && t.name === event.name,
          );
          const chip = {
            name: event.name,
            ok: event.ok,
            summary: event.summary,
          };
          if (idx >= 0) tools[idx] = chip;
          else tools.push(chip);
          last.tools = tools;
          break;
        }
        case "error":
          last.error = event.message;
          break;
        case "done":
          break;
      }
      return [...prev.slice(0, -1), last];
    });
  }, []);

  const send = async (text: string) => {
    const message = text.trim();
    // `messages === null` means the history fetch is still in flight. Its `.then` REPLACES the
    // transcript, so a turn appended before it lands — and the reply streaming into it — would vanish.
    if (!message || !sessionId || streaming || messages === null) return;
    setInput("");
    const now = new Date().toISOString();
    setMessages((prev) => [
      ...(prev ?? []),
      { role: "user", content: message, at: now },
      { role: "assistant", content: "", tools: [], at: now },
    ]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        { session_id: sessionId, message, context },
        applyEvent,
        controller.signal,
      );
      onTurnComplete?.();
    } catch (e) {
      // A Stop click aborts the fetch; that is the user's decision, not a failure to report.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        applyEvent({ type: "error", message: String(e) });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  const reset = () => {
    stop();
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to clear; the new id below still replaces the old one for this tab.
    }
    setSessionId(loadSessionId());
  };

  return (
    <Panel className="rc-rise flex h-[calc(100vh-220px)] min-h-[520px] flex-col p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Eyebrow>Assistant</Eyebrow>
          {sessionId && (
            <span
              className="rc-mono truncate text-[10.5px] text-[var(--rc-ink-faint)]"
              title="chat session id"
            >
              {sessionId}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={reset}
          className={BTN_LINK}
          disabled={!sessionId}
        >
          New session
        </button>
      </div>

      {context && (context.deal_id || context.email_id) && (
        <p className="rc-mono mt-3 rounded border border-[var(--rc-cyan)] bg-[var(--rc-panel-2)] px-3 py-2 text-[11.5px] text-[var(--rc-ink)]">
          Context attached to every message:{" "}
          {context.deal_id && (
            <span>
              deal{" "}
              <span className="text-[var(--rc-cyan)]">{context.deal_id}</span>
            </span>
          )}
          {context.deal_id && context.email_id && " · "}
          {context.email_id && (
            <span>
              email{" "}
              <span className="text-[var(--rc-cyan)]">{context.email_id}</span>
            </span>
          )}
        </p>
      )}

      <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {!messages ? (
          <Placeholder kind="loading">◆ loading the conversation…</Placeholder>
        ) : messages.length === 0 ? (
          <div className="space-y-3">
            {historyError && (
              <p className="rc-mono text-[11px] text-[var(--rc-amber)]">
                Could not load earlier turns — {historyError}
              </p>
            )}
            <Placeholder kind="empty">
              <span>
                ◇ Ask about a deal, an upload failure or a parsing rule. The
                assistant can read deals, emails, skills and memory, and will
                ask before writing anything.
              </span>
            </Placeholder>
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rc-mono rounded border border-[var(--rc-line)] px-3 py-1.5 text-left text-[11.5px] text-[var(--rc-ink-dim)] hover:border-[var(--rc-cyan)] hover:text-[var(--rc-ink)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`rc-bubble ${m.role}`}>
              {m.role === "user" ? (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--rc-ink)]">
                  {m.content}
                </p>
              ) : (
                <>
                  {m.tools && m.tools.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {m.tools.map((t, j) => {
                        // A refusal is a failure whatever the flag says: the write did not happen.
                        const failed =
                          !t.pending && (!t.ok || isAdminRefusal(t.summary));
                        return (
                          <span
                            key={`${t.name}-${j}`}
                            className="rc-chip"
                            data-tool-state={
                              t.pending ? "pending" : failed ? "failed" : "ok"
                            }
                            style={{
                              color: t.pending
                                ? "var(--rc-violet)"
                                : failed
                                  ? "var(--rc-red)"
                                  : "var(--rc-cyan)",
                            }}
                            title={t.summary}
                          >
                            {t.pending ? "⟳ " : failed ? "✕ " : "✓ "}
                            {t.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* The chip's title is hover-only. Someone who asked for a rule to be saved and was
                      refused needs to read the reason, not discover it. */}
                  {m.tools
                    ?.filter((t) => !t.pending && isAdminRefusal(t.summary))
                    .map((t, j) => (
                      <p
                        key={`${t.name}-refused-${j}`}
                        role="alert"
                        className="rc-mono mb-2 text-[11.5px]"
                        style={{ color: "var(--rc-red)" }}
                      >
                        ⚠ {t.name} — {t.summary}
                      </p>
                    ))}
                  {m.content ? (
                    <MarkdownLite text={m.content} />
                  ) : streaming && i === messages.length - 1 && !m.error ? (
                    <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
                      ▍
                    </p>
                  ) : null}
                  {m.error && (
                    <p
                      className="rc-mono mt-2 text-[11.5px]"
                      style={{ color: "var(--rc-red)" }}
                    >
                      ⚠ {m.error}
                    </p>
                  )}
                </>
              )}
              <p className="rc-mono mt-1.5 text-right text-[10px] text-[var(--rc-ink-faint)]">
                {formatDateTime(m.at)}
              </p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <form
        className="mt-4 flex items-end gap-2 border-t border-[var(--rc-line)] pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline, the convention every chat surface uses.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={2}
          placeholder={
            !sessionId
              ? "starting a session…"
              : messages === null
                ? "loading the conversation…"
                : "Message the assistant…"
          }
          // Closed until the history has landed, for the reason `send` gives: a turn typed into the
          // gap would be overwritten by it.
          disabled={!sessionId || messages === null}
          className={`${INPUT_CLASS} flex-1 resize-none leading-relaxed`}
        />
        {streaming ? (
          <button type="button" onClick={stop} className={BTN_QUIET}>
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!sessionId || messages === null || !input.trim()}
            className={BTN_PRIMARY}
          >
            Send
          </button>
        )}
      </form>
    </Panel>
  );
}
