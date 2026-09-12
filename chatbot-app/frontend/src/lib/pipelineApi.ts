// Typed client for the deal-pipeline BFF. Calls SAME-ORIGIN Next.js API routes (`/api/pipeline/*`,
// design §9) which reach AWS with the developer's credentials — no cross-origin fetch, no CORS.
//
// Every call goes through `pipelineFetch` below — the shared `authedFetch` under the pipeline's log
// label — which attaches the caller's OIDC ID token and starts a re-authentication redirect on a
// 401. That is not optional: `src/proxy.ts` rejects an unauthenticated request to `/api/pipeline/*`
// before the route handler runs. Use `pipelineFetch` — never a bare `fetch` — for anything under
// `/api/pipeline`.

import { jsonInit, listOf, parseJsonResponse } from "@/lib/api/client";
import { authedFetch } from "@/lib/auth/authed-fetch";
import type { MemoryStrategyResponse } from "@/lib/memoryStrategy";
import type {
  ChatMessage,
  ChatStreamEvent,
  DealRecord,
  EmailRecord,
  FieldValues,
  MemoryRecord,
  ProposalStatus,
  SampleEmail,
  SkillProposal,
} from "@/lib/pipeline/types";

/** The one authenticated `fetch` for `/api/pipeline/*`, so a failed redirect is logged as the pipeline's. */
const pipelineFetch = (input: string, init?: RequestInit): Promise<Response> =>
  authedFetch(input, init, "PipelineAuth");

/**
 * The shared JSON reader (`lib/api/client.ts`) under the pipeline label: `body.error` when the route
 * explained itself, `pipeline API error <status>` when it did not, `undefined` for an empty 2xx body.
 */
const json = <T>(resp: Response): Promise<T> => parseJsonResponse<T>(resp, "pipeline API");

// --- Inbox -----------------------------------------------------------------------------------------

/** The fictional sample corpus the Simulate dialog offers. */
export async function listSamples(): Promise<SampleEmail[]> {
  return listOf(await json(await pipelineFetch("/api/pipeline/samples")), "samples");
}

/** Every email the pipeline has received. The inbox sorts newest first itself. */
export async function listEmails(): Promise<EmailRecord[]> {
  return listOf(await json(await pipelineFetch("/api/pipeline/emails")), "emails");
}

/** A pasted email, for the "paste an email" mode of the Simulate dialog. */
export interface RawEmailInput {
  from: string;
  subject: string;
  body: string;
  /** ISO-8601. */
  sent: string;
}

/**
 * Simulate an incoming email: either one of the corpus samples or a pasted one.
 *
 * The route creates the record, async-invokes the parser and returns the record while it is still
 * RECEIVED — the inbox and the detail page poll for the status to move.
 */
export async function createEmail(
  input: { sample_id: string } | { raw: RawEmailInput },
): Promise<EmailRecord> {
  return json(await pipelineFetch("/api/pipeline/emails", jsonInit("POST", input)));
}

export async function getEmail(id: string): Promise<EmailRecord> {
  return json(await pipelineFetch(`/api/pipeline/emails/${encodeURIComponent(id)}`));
}

/** Re-run the parser on an email; status goes back to PARSING. */
export async function reparseEmail(id: string): Promise<EmailRecord> {
  return json(
    await pipelineFetch(`/api/pipeline/emails/${encodeURIComponent(id)}/reparse`, {
      method: "POST",
    }),
  );
}

// --- Deals -----------------------------------------------------------------------------------------

export async function listDeals(): Promise<DealRecord[]> {
  return listOf(await json(await pipelineFetch("/api/pipeline/deals")), "deals");
}

export async function getDeal(id: string): Promise<DealRecord> {
  return json(await pipelineFetch(`/api/pipeline/deals/${encodeURIComponent(id)}`));
}

/**
 * Replace the deal's current field values. The route validates formats, stores them, regenerates
 * the staging CSV and appends an EDITED history entry.
 */
export async function updateDealFields(
  id: string,
  fields: FieldValues,
): Promise<DealRecord> {
  return json(
    await pipelineFetch(
      `/api/pipeline/deals/${encodeURIComponent(id)}`,
      jsonInit("PATCH", { fields }),
    ),
  );
}

/** The staging CSV as text, for the Download button. */
export async function getDealCsv(id: string): Promise<string> {
  const resp = await pipelineFetch(`/api/pipeline/deals/${encodeURIComponent(id)}/csv`);
  // Reuse the error path so a failed download names the reason like every other call.
  if (!resp.ok) await json(resp);
  return resp.text();
}

/**
 * Approve and upload: status → APPROVED, the mock OMS validates synchronously, and the deal comes
 * back UPLOADED or UPLOAD_FAILED with its `upload` result filled in. Admin-gated server-side.
 */
export async function approveDeal(id: string): Promise<DealRecord> {
  return json(
    await pipelineFetch(`/api/pipeline/deals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),
  );
}

/** Reject with a reason. Admin-gated server-side. */
export async function rejectDeal(id: string, reason: string): Promise<DealRecord> {
  return json(
    await pipelineFetch(
      `/api/pipeline/deals/${encodeURIComponent(id)}/reject`,
      jsonInit("POST", { reason }),
    ),
  );
}

// --- Assistant -------------------------------------------------------------------------------------

/** Body of `POST /api/pipeline/chat` (design §9). */
export interface ChatRequest {
  session_id: string;
  message: string;
  context?: { deal_id?: string; email_id?: string };
}

/**
 * Dispatch every `data:` line of an SSE body as a parsed event.
 *
 * Chunks arrive split anywhere — mid-line, mid-JSON — so bytes are buffered until a newline and the
 * tail is carried into the next chunk. A trailing line with no newline is flushed at the end, since
 * a server that closes the stream right after its `done` event never sends that last newline.
 * Lines that are not `data:` (comments, `event:` names, blanks) are skipped; a `data:` line that is
 * not JSON is surfaced as an `error` event rather than thrown, so one malformed frame costs one
 * message and not the whole reply.
 *
 * @param body the response body stream.
 * @param onEvent receives each event in order.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (!payload) return;
    try {
      onEvent(JSON.parse(payload) as ChatStreamEvent);
    } catch {
      onEvent({ type: "error", message: `unreadable stream frame: ${payload}` });
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      dispatch(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer.replace(/\r$/, ""));
}

/**
 * Send one chat turn and stream the assistant's reply.
 *
 * Resolves when the stream closes. A non-2xx response throws before any event is dispatched, with
 * the server's message; an aborted request rejects with the fetch's own AbortError, which the chat
 * panel treats as "the user stopped it" rather than as a failure.
 *
 * @param body the turn, with the session id and any deal/email context.
 * @param onEvent receives each stream event (design §7) in order.
 * @param signal optional abort signal for a Stop button.
 */
export async function streamChat(
  body: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await pipelineFetch("/api/pipeline/chat", {
    ...jsonInit("POST", body),
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    signal,
  });
  if (!resp.ok) await json(resp);
  if (!resp.body) throw new Error("the chat route returned no stream body");
  await readSseStream(resp.body, onEvent);
}

/** Prior turns of a session, rebuilt from the short-term chat memory. Empty for a new session. */
export async function getChatHistory(sessionId: string): Promise<ChatMessage[]> {
  return listOf(
    await json(
      await pipelineFetch(
        `/api/pipeline/chat/history?session_id=${encodeURIComponent(sessionId)}`,
      ),
    ),
    "messages",
  );
}

// --- Memory ----------------------------------------------------------------------------------------

export async function listMemory(): Promise<MemoryRecord[]> {
  return listOf(await json(await pipelineFetch("/api/pipeline/memory")), "records");
}

/**
 * Save a rule by hand, bypassing the assistant. The route writes a memory event; the consolidated
 * record appears after the service's extraction pass, which is seconds to a minute later.
 */
export async function addMemory(rule: string): Promise<void> {
  await json(await pipelineFetch("/api/pipeline/memory", jsonInit("POST", { rule })));
}

/** Outcome of a delete: which records went, and which the service refused, with its reason. */
export interface MemoryDeleteResult {
  deleted: string[];
  failed: { id: string; error: string }[];
}

/** Delete consolidated records. Admin-gated server-side. */
export async function deleteMemory(ids: string[]): Promise<MemoryDeleteResult> {
  const body = await json<Partial<MemoryDeleteResult> | undefined>(
    await pipelineFetch("/api/pipeline/memory", jsonInit("DELETE", { ids })),
  );
  // A route that reports nothing about partial failure has, by its own account, deleted them all.
  return { deleted: body?.deleted ?? ids, failed: body?.failed ?? [] };
}

// The strategy projection is the same module the route flattens with, re-exported so callers get the
// types from this client like every other API type. `configured` is false when KNOWLEDGE_MEMORY_ID is
// unset.
export type {
  MemoryStrategyInfo,
  MemoryStrategyOverride,
  MemoryStrategyResponse,
} from "@/lib/memoryStrategy";

/** The live extraction strategy behind the records. Read-only: Terraform owns it. */
export async function getMemoryStrategy(): Promise<MemoryStrategyResponse> {
  return json(await pipelineFetch("/api/pipeline/memory/strategy"));
}

// --- Skills ----------------------------------------------------------------------------------------

/** One catalog entry, from the SKILL.md frontmatter. */
export interface SkillSummary {
  name: string;
  description: string;
}

export async function listSkills(): Promise<SkillSummary[]> {
  return listOf(await json(await pipelineFetch("/api/pipeline/skills")), "skills");
}

export async function getSkill(name: string): Promise<{ name: string; content: string }> {
  return json(await pipelineFetch(`/api/pipeline/skills/${encodeURIComponent(name)}`));
}

/** Create a skill. Admin-gated server-side. */
export async function createSkill(name: string, content: string): Promise<void> {
  await json(await pipelineFetch("/api/pipeline/skills", jsonInit("PUT", { name, content })));
}

/** Overwrite a skill's SKILL.md. Admin-gated server-side. */
export async function saveSkill(name: string, content: string): Promise<void> {
  await json(
    await pipelineFetch(
      `/api/pipeline/skills/${encodeURIComponent(name)}`,
      jsonInit("PUT", { content }),
    ),
  );
}

/** Delete a skill. Admin-gated server-side. */
export async function deleteSkill(name: string): Promise<void> {
  await json(
    await pipelineFetch(`/api/pipeline/skills/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  );
}

/** The parsing agent's system prompt (`prompts/parser-system.md`). */
export async function getParserPrompt(): Promise<{ content: string }> {
  return json(await pipelineFetch("/api/pipeline/skills/system-prompt"));
}

/** Overwrite the parser prompt. Admin-gated server-side. */
export async function saveParserPrompt(content: string): Promise<void> {
  await json(
    await pipelineFetch("/api/pipeline/skills/system-prompt", jsonInit("PUT", { content })),
  );
}

/**
 * Skill-update proposals, optionally one status only.
 *
 * Filtered server-side when a status is given, but the pages filter again client-side so a route that
 * ignores the query still shows the right rows.
 */
export async function listProposals(status?: ProposalStatus): Promise<SkillProposal[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const all = listOf<SkillProposal>(
    await json(await pipelineFetch(`/api/pipeline/skills/proposals${qs}`)),
    "proposals",
  );
  return status ? all.filter((p) => p.status === status) : all;
}

/** A manual proposal, written the same way the assistant's `propose_skill_update` tool writes one. */
export async function createProposal(input: {
  skill_name: string;
  summary: string;
  rationale: string;
  proposed_content: string;
}): Promise<SkillProposal> {
  return json(
    await pipelineFetch("/api/pipeline/skills/proposals", jsonInit("POST", input)),
  );
}

/** Approve (writes the SKILL.md to S3) or reject a proposal. Admin-gated server-side. */
export async function decideProposal(
  id: string,
  decision: "approve" | "reject",
): Promise<SkillProposal> {
  return json(
    await pipelineFetch(
      `/api/pipeline/skills/proposals/${encodeURIComponent(id)}`,
      jsonInit("POST", { decision }),
    ),
  );
}

// --- Config ----------------------------------------------------------------------------------------

export interface PipelineConfig {
  /** The parser's Bedrock model id from SSM. Null when the parameter has no value yet. */
  modelId: string | null;
  /** The ids the PUT accepts, when the route publishes them; the Config page checks against these. */
  modelIds?: readonly string[];
  /** The console-wide default model (Settings → Defaults), offered as "Use console default"; null when none. */
  consoleDefaultModelId?: string | null;
}

export async function getConfig(): Promise<PipelineConfig> {
  return json(await pipelineFetch("/api/pipeline/config"));
}

/** Change the parser model. Admin-gated server-side. */
export async function saveConfig(modelId: string): Promise<PipelineConfig> {
  return json(await pipelineFetch("/api/pipeline/config", jsonInit("PUT", { modelId })));
}
