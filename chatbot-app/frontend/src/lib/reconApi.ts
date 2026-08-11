// Typed client for the reconciliation BFF. Calls SAME-ORIGIN Next.js API routes
// (/api/recon/*) which read DynamoDB + the S3 skills catalog via the ECS task role — no
// cross-origin fetch, no CORS. The `token` params are retained for signature stability but
// unused (the server routes reach AWS with the task role).
//
// Every call goes through `reconFetch`, which attaches the caller's OIDC ID token. That is not
// optional: src/proxy.ts rejects an unauthenticated request to /api/recon/* before the
// route handler runs. Use reconFetch — never a bare fetch — for anything under /api/recon.

import { reconFetch } from "@/lib/recon-auth";

export type TraceKind =
  | "lesson_recall"
  | "classify"
  | "skill_load"
  | "tool_call"
  | "execute"
  | "propose";

export interface ReasoningStep {
  skill: string;
  confidence: string; // Decimal serialized as string (model-only; not shown per-entry)
  reasoning: string;
  evidence: string[];
  // Typed-trace fields (absent on legacy steps).
  kind?: TraceKind;
  tool?: string; // tool_call: invoked tool name
  tool_input?: Record<string, unknown>; // tool_call: arguments sent
  tool_output?: string; // tool_call: result summary
  action?: Record<string, unknown>; // execute: the structured write performed
  outcome?: string; // execute: "executed" | "failed: <msg>" | "escalated"
  // When this step was recorded (UTC ISO-8601) — shown in the trace for review.
  ts?: string;
}

// IDP-derived detail embedded on the recon item at ingest (from IDP output S3).
export interface IdpSection {
  section_id: string;
  classification?: string | null;
  page_indices?: number[];
  fields?: Record<string, unknown>; // extracted key-value results
  output_uri?: string;
}
export interface IdpPage {
  page_id: string;
  image_uri: string;
  // Key inside RECON's assets bucket (copied at ingest) — served via /api/recon/page-image.
  local_key?: string;
}
export interface IdpDetail {
  idp_class?: string | null;
  idp_attributes?: Record<string, unknown>;
  idp_sections?: IdpSection[];
  idp_pages?: IdpPage[];
  idp_page_count?: number | null;
  idp_confidence_alert_count?: number | null;
  idp_workflow_status?: string | null;
  idp_raw_ref?: string;
  // IDP Assessment classification confidence (0..1), when the IDP pipeline emits it.
  idp_classification_confidence?: string | number | null;
  // IDP Step-Function run id of the extraction currently embedded — a new run id means the
  // document was reprocessed in IDP and this case was re-driven with the fresh extraction.
  idp_execution_arn?: string | null;
}

/** Draft lifecycle, mirroring `backend/recon_core/email_policy.py`'s DRAFT_* constants. */
export type DraftStatus = "pending" | "approved" | "discarded" | "sent";

/**
 * The counterparty email draft persisted on a case.
 *
 * Structurally the same map `lib/emailDraftStore.ts` writes, redeclared here rather than imported
 * because that module pulls in the DynamoDB client and this type is used by client components.
 */
export interface EmailDraft {
  /** Null until an analyst supplies it — the model's proposed address is always discarded. */
  recipient: string | null;
  /** Who the model believes it is writing to. Display only; never used as an address. */
  recipient_hint?: string;
  subject: string;
  body: string;
  draft_status: DraftStatus;
  /** Bumped by every edit. Sent back with each action so a lost race fails instead of overwriting. */
  revision: number;
  /** The revision that was approved; the send is refused unless it still equals `revision`. */
  approved_revision?: number | null;
  edited_by?: string | null;
  edited_at?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  discarded_by?: string | null;
  discarded_at?: string | null;
  /** Set with `sent_at` still null: a send was started and its outcome is unknown. */
  send_attempted_at?: string | null;
  sent_at?: string | null;
}

export interface ReconCase {
  item_id: string;
  status: string;
  class_id?: string;
  classification_confidence?: string;
  classification_reasoning?: string;
  resolution?: string;
  confidence?: string;
  // Breakdown of the computed composite confidence (consistency/grounding/verbalized).
  confidence_components?: {
    consistency?: string;
    grounding?: string;
    verbalized?: string;
    idp_alerts?: number;
  };
  steps?: ReasoningStep[];
  // Structured executable action the agent derived (null when nothing was safely actionable).
  proposed_action?: Record<string, unknown> | null;
  // Counterparty email the agent drafted, if it proposed writing to anyone. Absent on most cases.
  proposed_email?: EmailDraft | null;
  // Full nested item as stored (carries attributes.idp_* from the hook).
  item?: { attributes?: IdpDetail; source_refs?: string[] };
}

export interface SkillType {
  name: string;
  description: string;
  // Gateway tools this skill uses (from frontmatter `tools: [...]`).
  tools: string[];
  // Optional per-skill model override (frontmatter `model:`), else null.
  model: string | null;
}

export interface Lesson {
  lesson_id: string;
  created_at: string;
  domain: string;
  class_id: string;
  item_id: string;
  trigger: string;
  disposition?: string;
  user_comment?: string;
}

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = `recon API error ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

export async function listCases(
  _token?: string,
  opts?: { scope?: "all"; status?: string },
): Promise<ReconCase[]> {
  const q = new URLSearchParams();
  if (opts?.status) q.set("status", opts.status);
  else if (opts?.scope) q.set("scope", opts.scope);
  const qs = q.toString();
  return json(await reconFetch(`/api/recon/cases${qs ? `?${qs}` : ""}`));
}

// Bulk status update from the queue: set status (+ optional comment) on several cases at once.
export async function bulkUpdateCases(
  itemIds: string[],
  status: "IN_PROGRESS" | "CLOSED_NO_ACTION",
  comment?: string,
): Promise<{
  updated: string[];
  failed: { item_id: string; error: string }[];
}> {
  return json(
    await reconFetch(`/api/recon/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_ids: itemIds, status, comment }),
    }),
  );
}

// item_id can contain '#', spaces, etc. (e.g. "idp-Borrowing_Notice_#1.pdf"). The Next.js route
// param can arrive EITHER decoded ("#1") or still-encoded ("%231") depending on the segment, so a
// bare encodeURIComponent would double-encode the already-encoded form ("%2523...") and miss the
// DynamoDB key. Normalize by decoding first, then encoding exactly once. Fail-safe if `id` isn't
// valid percent-encoding.
function encodeItemId(id: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(id));
  } catch {
    return encodeURIComponent(id);
  }
}

export async function getCase(id: string, _token?: string): Promise<ReconCase> {
  return json(await reconFetch(`/api/recon/cases/${encodeItemId(id)}`));
}

// Stuck-IN_PROGRESS recovery: re-drive the investigation (retry) or close the case (cancel).
export async function retryCase(id: string): Promise<{ status: string }> {
  return json(
    await reconFetch(`/api/recon/cases/${encodeItemId(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    }),
  );
}

export async function cancelCase(
  id: string,
  comment?: string,
): Promise<{ status: string }> {
  return json(
    await reconFetch(`/api/recon/cases/${encodeItemId(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", comment }),
    }),
  );
}

/**
 * Approve the case: execute the deferred action, send the approved counterparty draft if there is
 * one, resolve.
 *
 * @param id - the case id.
 * @param comment - optional decision comment (required when the platform mode says so).
 * @param draft - present only when this case carries an approved draft. `revision` is the one the
 *   panel is displaying; the BFF 409s if the row has moved on, which is what stops an approval from
 *   sending text the analyst never saw. `overrideUnknownSend` re-arms a draft whose earlier send
 *   outcome is unknown, and belongs to an explicit human decision after checking Sent Items.
 */
/**
 * Approve a case: send its approved counterparty draft (if any), then resolve it.
 *
 * @param id case/item id.
 * @param comment optional approver comment.
 * @param draft the pinned revision when an approved draft is being sent with this approval.
 * @returns the resulting status, plus `notification_error` when the case resolved but the internal
 *   resolution notification could not be sent. That is not a failed approval — the case IS closed —
 *   so it comes back beside the status rather than as a thrown error.
 */
export async function approveCase(
  id: string,
  comment?: string,
  draft?: { revision: number; overrideUnknownSend?: boolean },
): Promise<{ status: string; notification_error?: string }> {
  return json(
    await reconFetch(`/api/recon/cases/${encodeItemId(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        comment,
        ...(draft
          ? {
              draft_revision: draft.revision,
              ...(draft.overrideUnknownSend
                ? { override_unknown_send: true }
                : {}),
            }
          : {}),
      }),
    }),
  );
}

/**
 * Replace the draft's recipient, subject and body, returning it at its new revision.
 *
 * @param id - the case id.
 * @param draft - the edited fields plus the `revision` being edited.
 * @returns the stored draft — `pending` again, since an edit revokes any approval.
 */
export async function saveEmailDraft(
  id: string,
  draft: {
    recipient: string;
    subject: string;
    body: string;
    revision: number;
  },
): Promise<{ proposed_email: EmailDraft }> {
  return json(
    await reconFetch(`/api/recon/cases/${encodeItemId(id)}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }),
  );
}

/**
 * Decide the draft's fate without touching the case: approve, withdraw an approval, or discard.
 *
 * @param id - the case id.
 * @param action - which decision to record.
 * @param revision - the revision the analyst is acting on; a stale one is refused with 409.
 * @returns the updated draft.
 */
export async function decideEmailDraft(
  id: string,
  action: "approve_draft" | "revoke_draft" | "discard_draft",
  revision: number,
): Promise<{ proposed_email: EmailDraft }> {
  return json(
    await reconFetch(`/api/recon/cases/${encodeItemId(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, draft_revision: revision }),
    }),
  );
}

// Disapprove: a correction comment is required; outcome closes the case (no_action) or
// re-triggers the agent with the comment (reprocess).
export async function rejectCase(
  id: string,
  comment: string,
  outcome: "no_action" | "reprocess",
): Promise<{ status: string }> {
  return json(
    await reconFetch(`/api/recon/cases/${encodeItemId(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", comment, outcome }),
    }),
  );
}

export async function listSkills(_token?: string): Promise<SkillType[]> {
  return json(await reconFetch(`/api/recon/skills`));
}

// --- Skills CRUD + system prompt ---

export async function getSkill(
  name: string,
): Promise<{ name: string; content: string }> {
  return json(await reconFetch(`/api/recon/skills/${name}`));
}

export async function createSkill(
  name: string,
  content: string,
): Promise<{ name: string }> {
  return json(
    await reconFetch(`/api/recon/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    }),
  );
}

export async function saveSkill(
  name: string,
  content: string,
): Promise<{ name: string }> {
  return json(
    await reconFetch(`/api/recon/skills/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
}

export async function deleteSkill(name: string): Promise<{ deleted: string }> {
  return json(
    await reconFetch(`/api/recon/skills/${name}`, { method: "DELETE" }),
  );
}

export async function getSystemPrompt(): Promise<{ content: string }> {
  return json(await reconFetch(`/api/recon/system-prompt`));
}

export async function saveSystemPrompt(
  content: string,
): Promise<{ ok: boolean }> {
  return json(
    await reconFetch(`/api/recon/system-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
}

// --- Lessons learned ---

export async function listLessons(domain?: string): Promise<Lesson[]> {
  const q = domain ? `?domain=${encodeURIComponent(domain)}` : "";
  return json(await reconFetch(`/api/recon/lessons${q}`));
}

// Agent long-term memory: consolidated lessons read live from AgentCore Memory (distinct from
// the DynamoDB lessons ledger above). Empty when RECON_MEMORY_ID is not configured.
export interface MemoryRecord {
  id: string;
  domain: string;
  namespace: string;
  content: string;
  createdAt: string;
}

export async function getMemoryRecords(): Promise<MemoryRecord[]> {
  return json(await reconFetch(`/api/recon/memory`));
}

// --- Platform config: Tier-1 toggle + read-only Lambda source viewer ---

export interface PlatformConfig {
  tier1Enabled: boolean;
  // Composite-confidence threshold for straight-through processing; null = disabled.
  autoResolveThreshold: number | null;
  // Decision-comment requirement on approve/disapprove.
  commentRequirement: "required" | "optional" | "disapprove-only";
  // Tier-2 agent backend: container Runtime or managed Harness (runtime-switchable).
  agentBackend: "runtime" | "harness";
  // Domains a counterparty email may be addressed to. READ-ONLY here: it comes from the deploy's
  // environment (terraform `counterparty_email_domains`), and the BFF rejects an attempt to PUT it
  // rather than accepting a change the interceptor would not honor. Empty means no counterparty
  // email can be sent at all.
  counterpartyEmailDomains?: string[];
}

export async function getConfig(): Promise<PlatformConfig> {
  return json(await reconFetch(`/api/recon/config`));
}

export async function saveConfig(
  cfg: Partial<PlatformConfig>,
): Promise<Partial<PlatformConfig>> {
  return json(
    await reconFetch(`/api/recon/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  );
}

export interface LambdaSourceFile {
  path: string;
  content: string;
}

export async function getLambdaSource(
  src?: "tier1" | "agent",
): Promise<LambdaSourceFile[]> {
  const q = src === "agent" ? "?src=agent" : "";
  return json(await reconFetch(`/api/recon/lambda-src${q}`));
}

// --- Evals ---

export interface EvalSummary {
  days: number;
  series: Record<
    string,
    { timestamps: string[]; averages: number[]; counts: number[] }
  >;
}

export async function getEvalSummary(days = 7): Promise<EvalSummary> {
  return json(await reconFetch(`/api/recon/evals/summary?days=${days}`));
}

export interface EvalResult {
  sessionId: string;
  evaluator: string;
  value: string;
  label: string;
  explanation: string;
  "@timestamp": string;
}

export async function getEvalResults(
  limit = 50,
): Promise<{ results: EvalResult[] }> {
  return json(await reconFetch(`/api/recon/evals/results?limit=${limit}`));
}

// Per-case drill-down: the latest evaluation run for one recon case.
export interface CaseEvalRecord {
  evaluator: string;
  value: string | null;
  label: string | null;
  explanation: string | null;
  error: string | null;
  timestamp: string;
}

export interface CaseEvals {
  session: string | null;
  records: CaseEvalRecord[];
}

export async function getCaseEvals(id: string): Promise<CaseEvals> {
  return json(await reconFetch(`/api/recon/cases/${encodeItemId(id)}/evals`));
}

export async function startBatchEval(body: {
  name?: string;
  evaluatorIds: string[];
  sessionIds?: string[];
}): Promise<{ batchEvaluationId: string }> {
  return json(
    await reconFetch(`/api/recon/evals/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export interface BatchEvalStatus {
  status: string;
  evaluationResults?: unknown;
  failureReason?: string;
}

export async function getBatchEval(id: string): Promise<BatchEvalStatus> {
  return json(await reconFetch(`/api/recon/evals/batch?id=${id}`));
}

// A system-prompt recommendation is a THREE-request handshake, not one call: the source batch
// evaluation takes ~65s, well past CloudFront's 60s origin_read_timeout, so the wait has to
// happen in the browser rather than inside a request. Order:
//   startRecommendation({type})                        → {phase:"BATCH", batchEvaluationId}
//   getRecommendationBatch(batchEvaluationId)          → poll until !running
//   startRecommendation({type, batchEvaluationArn})    → {recommendationId}
//   getRecommendation(recommendationId)                → poll until terminal
// Tool-description recommendations skip straight to step 3 (no batch source; the API rejects it).
export async function startRecommendation(body: {
  type: "SYSTEM_PROMPT_RECOMMENDATION" | "TOOL_DESCRIPTION_RECOMMENDATION";
  startTime?: string;
  endTime?: string;
  currentPrompt?: string;
  tools?: { toolName: string; description: string }[];
  batchEvaluationArn?: string;
}): Promise<{
  recommendationId?: string;
  phase?: "BATCH";
  batchEvaluationId?: string;
  backend?: string;
  name?: string;
  // Where the prompt being optimized came from, e.g. "runtime:s3:system-prompt.md" or
  // "harness:config:v0007". The optimizer screens that prompt with prompt-attack protection and
  // can reject it, so the failure has to name the artifact the user must edit.
  promptSource?: string | null;
}> {
  return json(
    await reconFetch(`/api/recon/evals/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export interface RecommendationBatchStatus {
  status: string;
  running: boolean;
  // Populated only once the batch is usable as a trace source (COMPLETED/COMPLETED_WITH_ERRORS).
  batchEvaluationArn: string | null;
}

export async function getRecommendationBatch(
  batchEvaluationId: string,
): Promise<RecommendationBatchStatus> {
  return json(
    await reconFetch(
      `/api/recon/evals/recommendations?batchId=${encodeURIComponent(batchEvaluationId)}`,
    ),
  );
}

export interface RecommendedTool {
  toolName: string;
  recommendedToolDescription: string;
  explanation?: string;
}

export interface Recommendation {
  status: string;
  type?: string | null;
  recommendedSystemPrompt?: string | null;
  systemPromptExplanation?: string | null;
  recommendedTools?: RecommendedTool[] | null;
  // Conflicts between the suggested prompt and this platform's autonomy model. The optimizer's
  // safety pass injects a confirmation policy on every run, so this is usually non-empty for a
  // system-prompt recommendation — it is a review prompt, not an error.
  policyWarnings?: string[];
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function getRecommendation(id: string): Promise<Recommendation> {
  return json(await reconFetch(`/api/recon/evals/recommendations?id=${id}`));
}

// --- Harness config versions ---

export interface HarnessConfigVersion {
  version: string;
  created_at: string;
  comment: string;
  system_prompt: string;
  model_id: string;
  max_iterations: number;
  skills: string[];
  archived?: boolean;
  archived_at?: string | null;
}

export interface ConfigListResponse {
  configs: HarnessConfigVersion[];
  deployed: string | null;
  // Whether the prompt actually in effect still matches the deployed version's snapshot. false
  // means the shared prompt object was edited after the deploy — the Skills tab writes it directly
  // without moving the pointer — so the deployed version is a stale label, not the live text.
  // null = undeterminable (nothing deployed yet, or the prompt object is unreadable).
  liveMatchesDeployed: boolean | null;
  livePromptChars: number | null;
  archivedCount: number;
}

export async function getHarnessConfigs(
  includeArchived = false,
): Promise<ConfigListResponse> {
  return json(
    await reconFetch(
      `/api/recon/harness/configs${includeArchived ? "?includeArchived=1" : ""}`,
    ),
  );
}

// Archive hides a version from the list; it is never deleted, because the documents are the record
// of every prompt that ran and the deployed one is the rollback target. Archiving the deployed
// version is refused (409).
export async function setHarnessConfigArchived(
  version: string,
  archived: boolean,
): Promise<HarnessConfigVersion> {
  return json(
    await reconFetch(`/api/recon/harness/configs`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, archived }),
    }),
  );
}

// Live harness config (Config tab → Tier-2 backend, Harness view).
export interface HarnessInfo {
  configured: boolean;
  name: string;
  status?: string;
  model?: string;
  maxIterations?: number | null;
  allowedTools?: string[];
  skills?: string[];
  version?: number | null;
}

export async function getHarnessInfo(): Promise<HarnessInfo> {
  return json(await reconFetch(`/api/recon/harness/info`));
}

export async function createHarnessConfig(body: {
  comment?: string;
  system_prompt: string;
  model_id?: string;
  max_iterations?: number;
  skills?: string[];
}): Promise<HarnessConfigVersion> {
  return json(
    await reconFetch(`/api/recon/harness/configs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// Deploying a version writes its system_prompt into the SHARED prompt object (promptKey) that both
// Tier-2 backends read, and moves the SSM pointer. Before that, "deploy" only moved the pointer —
// which the runtime backend never reads, so it appeared to succeed while changing nothing.
// acknowledgeWarnings confirms the caller has seen the version's policy conflicts (409 otherwise):
// an optimizer-derived version carries an injected "wait for explicit approval" rule, and deploying
// it would tell both backends to wait for an approval this platform never asks for.
export async function deployHarnessConfig(
  version: string,
  acknowledgeWarnings = false,
): Promise<{ deployed: string; promptKey?: string }> {
  return json(
    await reconFetch(`/api/recon/harness/configs/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, acknowledgeWarnings }),
    }),
  );
}
