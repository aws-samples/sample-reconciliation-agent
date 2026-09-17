/**
 * The desk assistant: a Bedrock Converse streaming tool loop (design §7).
 *
 * One call to `runAssistantTurn` is one user message. It yields the stream-protocol events the
 * `/chat` route writes as SSE: text deltas as they arrive, a `tool_call` when the model asks for a
 * tool, a one-line `tool_result` once it has run, then `done`. Tool results are fed back to the model
 * and the loop continues until the model answers without tools or the round cap is hit.
 *
 * The assistant reads freely but writes through two gated paths only: `propose_skill_update`
 * creates a PENDING proposal a human approves, and `save_memory` writes an event the memory strategy
 * must extract. It never touches `skills/` in S3 and never edits a deal — the review screen is the
 * place for that, with a named actor.
 *
 * The memory-writing tools (`save_memory`, `delete_memory`) do what the admin-gated `/memory` REST
 * routes do, so they carry the same gate: a session whose caller is not in `PIPELINE_ADMIN_GROUP`
 * is not offered them at all (`toolsFor`) and, should the model call one anyway, `executeTool`
 * refuses. Proposals stay open to everyone because a proposal changes nothing until an admin
 * approves it.
 */

import {
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";

import type {
  ChatMessage,
  ChatStreamEvent,
  DealRecord,
} from "@/lib/pipeline/types";
import { validateSkill } from "@/lib/skillFrontmatter";
import { bedrock, getText } from "./aws";
import { getDeal, listDeals } from "./dealStore";
import { getEmail } from "./emailStore";
import { env } from "./env";
import {
  batchDelete,
  createRuleEvent,
  EDGE_CASES_NAMESPACE,
  appendChatEvent,
  listChatEvents,
  listRecords,
} from "./memoryClient";
import { createProposal } from "./proposalStore";
import { getAssistantPrompt, getSkill, listSkills } from "./skillsStore";

/** Tool rounds per turn. Eight covers "read the deal, read the email, read the skill, propose". */
export const MAX_TOOL_ROUNDS = 8;
/**
 * Output budget per model call. A skill proposal carries a table of counterparties and a few
 * paragraphs of rule text inside one tool call, so 4k was cut off mid-JSON; 8k leaves headroom
 * without inviting whole-file rewrites (the tool refuses those by design).
 */
export const MAX_OUTPUT_TOKENS = 8000;
/** Prior turns replayed to the model. Enough for a coherent conversation, small enough to stay cheap. */
const HISTORY_TURNS = 20;

/**
 * Used when `prompts/assistant-system.md` has not been seeded in the bucket. Kept in code so the
 * assistant works on a fresh deployment, and so the S3 copy has a starting point to edit from.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are the deal desk's pipeline assistant. The pipeline turns new-issue deal emails into OMS staging records: a parsing agent reads each email using its skills (universal rules) and recalled memories (situational rules), stages a deal, a reviewer approves it, and the OMS validator accepts or rejects the upload with error codes and hints.

Your job is to help the reviewer understand a deal or a failed upload, and to improve the pipeline through its two learning tiers:

1. Skills (universal). A rule that applies to every deal — a field the OMS always requires, a canonical naming convention — belongs in the skill. Use propose_skill_update with targeted edits (exact find/replace pairs) or an appended section; a human approves it on the Skills tab. Never say a skill has changed until its proposal is approved.
2. Memory (situational). A rule conditioned on a deal attribute, source format or counterparty — for example "project-finance term loans are First Lien in the OMS" — belongs in memory. Use save_memory with a one-sentence rule and the rationale.

How to work:
- Start from the data. Call get_deal or get_email before explaining an error, and quote the OMS error code and its hint.
- Diagnose, then propose. Explain what went wrong, say which tier the fix belongs to and why, show the exact rule or skill change, and ASK the user to confirm before calling propose_skill_update, save_memory or delete_memory. Read-only tools need no confirmation.
- When proposing a skill update, keep the frontmatter (name, description) intact and change only what the fix needs.
- Be concise; the reviewer is on a trading desk. Use the names in the data as they appear and do not invent counterparties or issuers.`;

// ---------------------------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------------------------

/** Converse tool specs. The descriptions are what the model reads, so they say when to use each. */
export const TOOL_SPECS: Tool[] = [
  {
    toolSpec: {
      name: "list_deals",
      description:
        "Recent deals with their status and upload outcome, newest first. Use to find a deal by name.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              description: "How many to return (default 10).",
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: "get_deal",
      description:
        "One deal in full: staged fields, evidence per field, assumptions, upload result with error codes and hints, history.",
      inputSchema: {
        json: {
          type: "object",
          properties: { deal_id: { type: "string" } },
          required: ["deal_id"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "get_email",
      description:
        "The raw email a deal came from, plus the parser's output (fields, evidence, memory hits, skills used).",
      inputSchema: {
        json: {
          type: "object",
          properties: { email_id: { type: "string" } },
          required: ["email_id"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "list_skills",
      description: "The parsing agent's skill catalog (name and description).",
      inputSchema: { json: { type: "object", properties: {} } },
    },
  },
  {
    toolSpec: {
      name: "get_skill",
      description: "Full SKILL.md content of one skill. Read it before proposing an update.",
      inputSchema: {
        json: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "list_counterparties",
      description:
        "The OMS canonical counterparty names and the aliases each maps from (security master). Ground any rule about arranger or agent naming in this list; never invent canonical names.",
      inputSchema: { json: { type: "object", properties: {} } },
    },
  },
  {
    toolSpec: {
      name: "propose_skill_update",
      description:
        "Propose a change to a SKILL.md for a human to approve. Universal rules only; nothing changes until approved. Express the change as `edits` (exact find/replace pairs against the current content) or `append_markdown` (a new section added at the end). Use `proposed_content` only when the whole skill is short.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            skill_name: { type: "string" },
            edits: {
              type: "array",
              description:
                "Targeted replacements. Each `find` must occur exactly once in the current SKILL.md.",
              items: {
                type: "object",
                properties: {
                  find: { type: "string" },
                  replace: { type: "string" },
                },
                required: ["find", "replace"],
              },
            },
            append_markdown: {
              type: "string",
              description: "Markdown appended after the current content, e.g. a new '## Learned rules' section.",
            },
            proposed_content: {
              type: "string",
              description: "The complete new SKILL.md including frontmatter. Only for short skills.",
            },
            summary: { type: "string", description: "One line for the proposals list." },
            rationale: {
              type: "string",
              description: "Why the change is needed, citing the deal or error it fixes.",
            },
          },
          required: ["skill_name", "summary", "rationale"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "list_memories",
      description:
        "Consolidated edge-case memory records the parser recalls. Use before saving to avoid duplicates.",
      inputSchema: { json: { type: "object", properties: {} } },
    },
  },
  {
    toolSpec: {
      name: "save_memory",
      description:
        "Save a situational parsing rule to memory. The rule must be one sentence a parser can apply.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            rule: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["rule", "rationale"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "delete_memory",
      description: "Delete one consolidated memory record by id, after the user confirms.",
      inputSchema: {
        json: {
          type: "object",
          properties: { record_id: { type: "string" } },
          required: ["record_id"],
        },
      },
    },
  },
];

/**
 * Tools that change the desk's shared memory. Admin-only, matching `POST`/`DELETE /memory`
 * (design §9): a saved rule alters every subsequent parse and a deleted record is shared state gone.
 */
export const ADMIN_ONLY_TOOLS: ReadonlySet<string> = new Set(["save_memory", "delete_memory"]);

/**
 * The tool catalog offered to a session.
 *
 * Non-admin sessions do not merely get a refusal when the model calls a memory tool — the tool is
 * withheld from the model entirely, so it neither proposes an action it cannot take nor learns the
 * shape of a call it is not entitled to make. `executeTool` still refuses independently, because the
 * catalog is advice to the model and the check is the gate.
 */
export function toolsFor(canWrite: boolean): Tool[] {
  return canWrite
    ? TOOL_SPECS
    : TOOL_SPECS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.toolSpec?.name ?? ""));
}

/** The refusal a non-admin session's memory write gets; the model relays it to the user. */
const ADMIN_REQUIRED_SUMMARY = "requires the admin group";

/** What a tool run hands back: a JSON object for the model and a one-liner for the UI. */
export interface ToolOutcome {
  ok: boolean;
  summary: string;
  result: Record<string, unknown>;
}

/** Per-turn facts the tools need that the model does not supply. */
export interface ToolContext {
  sessionId: string;
  dealId?: string;
  /** Whether the verified caller is in `PIPELINE_ADMIN_GROUP`; gates the memory-writing tools. */
  canWrite: boolean;
}

/** Security-master object the OMS validator also reads; the two must agree on canonical names. */
export const COUNTERPARTIES_KEY = "security-master/counterparties.csv";

/**
 * Parse `canonical_name,aliases` rows (aliases quoted, `;`-separated) into a list the model can
 * cite. Tolerates a missing header and blank lines; anything unparseable is skipped, not fatal.
 */
export function parseCounterpartiesCsv(
  csv: string,
): { canonical: string; aliases: string[] }[] {
  const out: { canonical: string; aliases: string[] }[] = [];
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.toLowerCase().startsWith("canonical_name")) continue;
    // Minimal RFC 4180: the aliases cell may be quoted because it contains ';' and spaces.
    const m = /^([^,]+),(?:"((?:[^"]|"")*)"|([^,]*))$/.exec(line);
    if (!m) continue;
    const aliases = (m[2] ?? m[3] ?? "")
      .replace(/""/g, '"')
      .split(";")
      .map((a) => a.trim())
      .filter(Boolean);
    out.push({ canonical: m[1].trim(), aliases });
  }
  return out;
}

/**
 * Resolve a proposal's new SKILL.md from whichever form the model chose.
 *
 * Skills run to tens of thousands of characters, far beyond what a tool call can carry, so the
 * model normally sends targeted `edits` or an `append_markdown` section and the server applies
 * them to the live content. Each `find` must match exactly once: zero matches means the model is
 * working from stale text, several means the edit is ambiguous, and both should fail loudly
 * rather than land in a proposal a reviewer might approve.
 *
 * @throws Error when no form is given, the skill does not exist, or an edit is not unique.
 */
export async function buildProposedContent(
  skillName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const full = typeof input.proposed_content === "string" ? input.proposed_content.trim() : "";
  if (full) return full;
  const edits = Array.isArray(input.edits) ? (input.edits as { find?: unknown; replace?: unknown }[]) : [];
  const append = typeof input.append_markdown === "string" ? input.append_markdown.trim() : "";
  if (edits.length === 0 && !append) {
    throw new Error("provide edits, append_markdown or proposed_content");
  }
  const current = await getSkill(skillName);
  if (current === null) throw new Error(`skill ${skillName} not found`);
  let content = current;
  edits.forEach((e, i) => {
    if (typeof e.find !== "string" || !e.find || typeof e.replace !== "string") {
      throw new Error(`edit ${i + 1}: find and replace must be strings`);
    }
    const count = content.split(e.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `edit ${i + 1}: find text occurs ${count} times in ${skillName}; it must occur exactly once`,
      );
    }
    // A function replacer inserts the text literally. With a string, `String.replace` expands `$`
    // patterns — "$&" to the match, "$'" to the whole remainder of the file — and the skills are
    // full of `$` (currency notes, code spans), so a model-supplied edit that kept one would splice
    // tens of kilobytes of the skill into the middle of the proposal without anyone noticing.
    const replacement = e.replace;
    content = content.replace(e.find, () => replacement);
  });
  if (append) content = `${content.trimEnd()}\n\n${append}\n`;
  return content;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} is required`);
  return v.trim();
}

/** Compact one-line description of a deal for lists and summaries. */
function dealLine(d: DealRecord): string {
  const upload = d.upload
    ? d.upload.accepted
      ? "upload accepted"
      : `upload rejected: ${d.upload.errors.map((e) => e.code).join(", ")}`
    : "not uploaded";
  return `${d.deal_id} ${d.opportunity_name} [${d.status}; ${upload}]`;
}

/**
 * Run one tool. Exported so the loop's plumbing and the tools' behaviour can be tested apart.
 *
 * Never throws: a failing tool is reported to the model as an error result so it can recover
 * (ask for a different id, apologise) instead of ending the whole turn.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  // Checked before the switch so no admin-only case can be reached without it — the REST routes
  // make the same check in `requireAppAdmin`, and this is the same write by another door.
  if (ADMIN_ONLY_TOOLS.has(name) && !ctx.canWrite) {
    return {
      ok: false,
      summary: ADMIN_REQUIRED_SUMMARY,
      result: {
        error: `${name} requires membership of the pipeline admin group; nothing was changed. Tell the user an admin can do this from the Memory Manager.`,
      },
    };
  }
  try {
    switch (name) {
      case "list_deals": {
        const limit = typeof input.limit === "number" ? input.limit : 10;
        const deals = await listDeals(limit);
        return {
          ok: true,
          summary: `${deals.length} deal${deals.length === 1 ? "" : "s"}`,
          result: {
            deals: deals.map((d) => ({
              deal_id: d.deal_id,
              email_id: d.email_id,
              opportunity_name: d.opportunity_name,
              status: d.status,
              created_at: d.created_at,
              upload_accepted: d.upload?.accepted ?? null,
              upload_errors: d.upload?.errors.map((e) => e.code) ?? [],
            })),
          },
        };
      }
      case "get_deal": {
        const id = str(input, "deal_id");
        const deal = await getDeal(id);
        if (!deal) return { ok: false, summary: `${id} not found`, result: { error: "deal not found" } };
        return { ok: true, summary: dealLine(deal), result: { deal } };
      }
      case "get_email": {
        const id = str(input, "email_id");
        const email = await getEmail(id);
        if (!email) return { ok: false, summary: `${id} not found`, result: { error: "email not found" } };
        return { ok: true, summary: `${id}: ${email.subject} [${email.status}]`, result: { email } };
      }
      case "list_skills": {
        const skills = await listSkills();
        return {
          ok: true,
          summary: `${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.map((s) => s.name).join(", ")}`,
          result: {
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
          },
        };
      }
      case "get_skill": {
        const skillName = str(input, "name");
        const content = await getSkill(skillName);
        if (content === null)
          return { ok: false, summary: `skill ${skillName} not found`, result: { error: "skill not found" } };
        return {
          ok: true,
          summary: `${skillName} (${content.length} chars)`,
          result: { name: skillName, content },
        };
      }
      case "propose_skill_update": {
        const skillName = str(input, "skill_name");
        const content = await buildProposedContent(skillName, input);
        // Refuse here, before a row exists, so a proposal can never be approved into a SKILL.md the
        // parser would fail to load.
        const invalid = validateSkill(content, skillName);
        if (invalid) return { ok: false, summary: `invalid SKILL.md: ${invalid}`, result: { error: invalid } };
        const proposal = await createProposal({
          skill_name: skillName,
          summary: str(input, "summary"),
          rationale: str(input, "rationale"),
          proposed_content: content,
          source: { kind: "assistant", session_id: ctx.sessionId, deal_id: ctx.dealId },
        });
        return {
          ok: true,
          summary: `proposal ${proposal.proposal_id} for ${skillName} is pending approval`,
          result: {
            proposal_id: proposal.proposal_id,
            status: proposal.status,
            note: "A human must approve this on the Skills tab before the parser sees it.",
          },
        };
      }
      case "list_counterparties": {
        const csv = await getText(COUNTERPARTIES_KEY);
        const counterparties = parseCounterpartiesCsv(csv ?? "");
        return {
          ok: true,
          summary: `${counterparties.length} canonical counterpart${counterparties.length === 1 ? "y" : "ies"}`,
          result: { counterparties },
        };
      }
      case "list_memories": {
        const records = await listRecords(EDGE_CASES_NAMESPACE);
        return {
          ok: true,
          summary: `${records.length} memory record${records.length === 1 ? "" : "s"}`,
          result: { records },
        };
      }
      case "save_memory": {
        const rule = str(input, "rule");
        const rationale = typeof input.rationale === "string" ? input.rationale : "";
        const eventId = await createRuleEvent(rule, rationale, `chat-${ctx.sessionId}`);
        if (eventId === null)
          return {
            ok: false,
            summary: "knowledge memory is not configured",
            result: { error: "KNOWLEDGE_MEMORY_ID is not set; nothing was saved" },
          };
        return {
          ok: true,
          summary: `saved: ${rule}`,
          result: {
            event_id: eventId,
            note: "Stored as an event; the memory strategy extracts it into a record within a few minutes.",
          },
        };
      }
      case "delete_memory": {
        const recordId = str(input, "record_id");
        const outcome = await batchDelete([recordId]);
        if (outcome === null)
          return {
            ok: false,
            summary: "knowledge memory is not configured",
            result: { error: "KNOWLEDGE_MEMORY_ID is not set; nothing was deleted" },
          };
        const ok = outcome.deleted.includes(recordId);
        return {
          ok,
          summary: ok ? `deleted ${recordId}` : `could not delete ${recordId}`,
          result: { ...outcome },
        };
      }
      default:
        return { ok: false, summary: `unknown tool ${name}`, result: { error: `unknown tool ${name}` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: message, result: { error: message } };
  }
}

// ---------------------------------------------------------------------------------------------
// Conversation assembly
// ---------------------------------------------------------------------------------------------

/**
 * Turn a stored transcript into Converse messages the API will accept.
 *
 * Converse requires strictly alternating roles starting with `user`. A transcript can violate that
 * — a turn that errored before the assistant answered leaves two user messages in a row — so
 * adjacent same-role turns are merged and a leading assistant turn is dropped. Exported for tests.
 */
export function toConverseHistory(transcript: ChatMessage[]): Message[] {
  const out: Message[] = [];
  for (const turn of transcript) {
    const role = turn.role === "assistant" ? "assistant" : "user";
    if (out.length === 0 && role === "assistant") continue;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content!.push({ text: turn.content });
    } else {
      out.push({ role, content: [{ text: turn.content }] });
    }
  }
  // Merged blocks read better to the model as one paragraph than as several fragments.
  return out.map((m) => ({
    role: m.role,
    content: [{ text: m.content!.map((c) => c.text ?? "").join("\n\n") }],
  }));
}

/** The short system-side note that tells the model what the user is looking at. */
export function contextNote(context?: { deal_id?: string; email_id?: string }): string | null {
  const parts: string[] = [];
  if (context?.deal_id) parts.push(`deal ${context.deal_id}`);
  if (context?.email_id) parts.push(`email ${context.email_id}`);
  if (!parts.length) return null;
  return `Context: the user is currently viewing ${parts.join(" and ")}. When they say "this deal" or "this email", use these ids with get_deal / get_email.`;
}

/**
 * The system-side note for a session that cannot write memory, or null for an admin.
 *
 * The default prompt tells the model to "use save_memory"; without this note a non-admin session
 * would be told to use a tool it was not given and either invent the call or apologise for a
 * failure it does not understand. Naming the alternative keeps the learning loop usable: the
 * reviewer still gets the rule, worded for the Memory Manager's manual add.
 */
export function roleNote(canWrite: boolean): string | null {
  if (canWrite) return null;
  return "Role: this user is not in the pipeline admin group, so save_memory and delete_memory are not available in this session. Diagnose, read memory and propose skill updates as usual; when a rule belongs in memory, state the one-sentence rule and tell the user an admin can add it from the Memory Manager.";
}

// ---------------------------------------------------------------------------------------------
// The streaming loop
// ---------------------------------------------------------------------------------------------

export interface AssistantTurnInput {
  sessionId: string;
  message: string;
  context?: { deal_id?: string; email_id?: string };
  /** Verified caller; chat memory is keyed on it. */
  actor: string;
  /** Whether the caller is in `PIPELINE_ADMIN_GROUP`; decides which tools the session is offered. */
  canWrite: boolean;
  /** Aborted when the browser disconnects. */
  signal?: AbortSignal;
}

/** A content block being assembled from stream deltas, keyed by contentBlockIndex. */
type PendingBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolUseId: string; name: string; json: string };

/** The SDK's JSON document type, which `unknown` is not assignable to without a cast. */
type JsonDocument = NonNullable<ToolUseBlock["input"]>;

/** Parse a tool's accumulated input JSON; an empty or malformed input reads as no arguments. */
function parseToolInput(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * Stream one assistant turn.
 *
 * Yields protocol events in order; the caller serialises them. The generator finishes after `done`,
 * or after `error` if the model call failed, or silently when the caller's signal aborts (there is
 * nobody left to read a `done`).
 */
export async function* runAssistantTurn(
  input: AssistantTurnInput,
): AsyncGenerator<ChatStreamEvent> {
  const { sessionId, message, context, actor, canWrite, signal } = input;
  const systemText = (await getAssistantPrompt()) ?? DEFAULT_SYSTEM_PROMPT;
  const system: SystemContentBlock[] = [{ text: systemText }];
  const note = contextNote(context);
  if (note) system.push({ text: note });
  const role = roleNote(canWrite);
  if (role) system.push({ text: role });
  const tools = toolsFor(canWrite);

  const transcript = await listChatEvents(sessionId, actor);
  const messages: Message[] = [
    ...toConverseHistory(transcript.slice(-HISTORY_TURNS)),
    { role: "user", content: [{ text: message }] },
  ];
  // Two user messages in a row can happen when the previous turn errored; merge so Converse accepts it.
  if (messages.length >= 2 && messages[messages.length - 2].role === "user") {
    const prev = messages.splice(messages.length - 2, 1)[0];
    messages[messages.length - 1].content = [
      { text: `${prev.content?.[0]?.text ?? ""}\n\n${message}` },
    ];
  }
  await appendChatEvent(sessionId, "user", message, actor);

  const ctx: ToolContext = { sessionId, dealId: context?.deal_id, canWrite };
  const finalText: string[] = [];

  try {
    let answered = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS && !answered; round++) {
      if (signal?.aborted) return;
      const resp = await bedrock().send(
        new ConverseStreamCommand({
          modelId: env.assistantModelId(),
          system,
          messages,
          toolConfig: { tools },
          inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS }, // no temperature: current Claude models reject it
        }),
        { abortSignal: signal },
      );

      const blocks = new Map<number, PendingBlock>();
      let stopReason: string | undefined;
      for await (const event of resp.stream ?? []) {
        if (event.contentBlockStart?.start?.toolUse) {
          const start = event.contentBlockStart.start.toolUse;
          blocks.set(event.contentBlockStart.contentBlockIndex ?? blocks.size, {
            kind: "tool",
            toolUseId: start.toolUseId ?? "",
            name: start.name ?? "",
            json: "",
          });
        } else if (event.contentBlockDelta) {
          const index = event.contentBlockDelta.contentBlockIndex ?? blocks.size;
          const delta = event.contentBlockDelta.delta;
          if (delta?.text) {
            const block = blocks.get(index);
            if (block?.kind === "text") block.text += delta.text;
            else blocks.set(index, { kind: "text", text: delta.text });
            finalText.push(delta.text);
            yield { type: "text", delta: delta.text };
          } else if (delta?.toolUse?.input) {
            const block = blocks.get(index);
            if (block?.kind === "tool") block.json += delta.toolUse.input;
          }
        } else if (event.messageStop) {
          stopReason = event.messageStop.stopReason;
        } else if (
          event.internalServerException ||
          event.modelStreamErrorException ||
          event.validationException ||
          event.throttlingException ||
          event.serviceUnavailableException
        ) {
          const failure =
            event.internalServerException ??
            event.modelStreamErrorException ??
            event.validationException ??
            event.throttlingException ??
            event.serviceUnavailableException;
          throw new Error(failure?.message ?? "model stream error");
        }
      }

      // Replay the assistant's message exactly as it was streamed, in block order.
      const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      const assistantContent: ContentBlock[] = [];
      const toolCalls: { toolUseId: string; name: string; input: unknown }[] = [];
      for (const block of ordered) {
        if (block.kind === "text") {
          if (block.text) assistantContent.push({ text: block.text });
        } else {
          const parsed = parseToolInput(block.json);
          assistantContent.push({
            toolUse: { toolUseId: block.toolUseId, name: block.name, input: parsed as JsonDocument },
          });
          toolCalls.push({ toolUseId: block.toolUseId, name: block.name, input: parsed });
        }
      }
      if (assistantContent.length) messages.push({ role: "assistant", content: assistantContent });

      if (stopReason === "max_tokens") {
        // The model ran out of output mid-answer or mid-tool-call. A truncated tool input parses
        // as {} and would fail confusingly inside the tool, so stop here and say what happened.
        yield {
          type: "error",
          message:
            "the assistant's reply hit the output limit before it finished; ask for a smaller change (targeted edits rather than a whole section)",
        };
        answered = true;
        break;
      }
      if (stopReason !== "tool_use" || toolCalls.length === 0) {
        answered = true;
        break;
      }

      const toolResults: ContentBlock[] = [];
      for (const call of toolCalls) {
        if (signal?.aborted) return;
        yield { type: "tool_call", name: call.name, input: call.input };
        const outcome = await executeTool(call.name, call.input, ctx);
        yield { type: "tool_result", name: call.name, ok: outcome.ok, summary: outcome.summary };
        toolResults.push({
          toolResult: {
            toolUseId: call.toolUseId,
            content: [{ json: outcome.result as JsonDocument }],
            status: outcome.ok ? "success" : "error",
          },
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    if (!answered) {
      yield {
        type: "error",
        message: `the assistant stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer`,
      };
    }
  } catch (err) {
    if (signal?.aborted) return;
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // Persist whatever the user saw, even after an error, so the transcript matches the screen.
  await appendChatEvent(sessionId, "assistant", finalText.join(""), actor).catch(() => false);
  yield { type: "done", session_id: sessionId };
}
