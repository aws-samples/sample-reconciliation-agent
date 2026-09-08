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
  | "evidence_step"
  | "propose";

export interface ReasoningStep {
  skill: string;
  // OPTIONAL because nothing writes it any more: every model-reported confidence number was
  // deleted on 2026-09-04, and `persist_proposal` drops the key when it is None. Steps stored
  // before that date still carry it (Decimal serialized as string), which is the only reason the
  // field is declared at all — no view renders a per-step confidence.
  confidence?: string;
  reasoning: string;
  evidence: string[];
  // Typed-trace fields (absent on a step emitted without a typed trace).
  kind?: TraceKind;
  tool?: string; // tool_call: invoked tool name
  tool_input?: Record<string, unknown>; // tool_call: arguments sent
  tool_output?: string; // tool_call: result summary
  action?: Record<string, unknown>; // execute: the structured write performed
  outcome?: string; // execute: "executed" | "failed: <msg>" | "escalated"
  // evidence_step: which prescribed step this entry reports on, and whether it obtained data.
  // `satisfied` is tri-state — undefined/null means the step was never attempted, which the UI
  // must show differently from an attempted-and-empty `false`.
  step_id?: string;
  satisfied?: boolean | null;
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
  // IDP Assessment classification confidence (0..1), when the IDP pipeline emits it. Deliberately
  // NOT rendered and deliberately NOT dead: it is how well IDP read the DOCUMENT, an input quality
  // measure that survived the 2026-09-04 removal of every model-reported confidence precisely
  // because it is not a self-report about the agent's own reasoning. It stays off the case view so
  // it cannot be mistaken for a second opinion on the evidence score; what the platform does act on
  // is `idp_confidence_alert_count` above, which the gateway interceptor reads to refuse a write.
  idp_classification_confidence?: string | number | null;
  // IDP Step-Function run id of the extraction currently embedded — a new run id means the
  // document was reprocessed in IDP and this case was re-driven with the fresh extraction.
  idp_execution_arn?: string | null;
}

/**
 * The `tier1_*` contract the Tier-1 stream consumer stamps onto an escalating item
 * (`backend/tier1/handler.py`). Both keys are written before the case opens, so both are present
 * from the moment the UI can see the case — except `tier1_break_type`, which is absent (never an
 * empty string) when no rule in `BREAK_TYPE_RULES` matched the item's shape.
 *
 * `tier1_break_type` is a HINT. The agent runs its own classification and may reach a different
 * answer, so a mismatch with the case's `class_id` is expected behaviour, not a conflict to
 * reconcile in the UI.
 */
export interface Tier1Detail {
  tier1_escalation_reason?: string | null;
  tier1_break_type?: string;
}

/**
 * Draft lifecycle, mirroring `backend/recon_core/email_policy.py`'s DRAFT_* constants.
 *
 * `render_failed` is not something an analyst did: the agent cited a template whose declared variables
 * and its payload disagreed, so the draft was stored visibly broken rather than dropped. It can be
 * edited or discarded but never approved.
 */
export type DraftStatus =
  "pending" | "approved" | "discarded" | "sent" | "render_failed";

/**
 * The counterparty email draft persisted on a case.
 *
 * Structurally the same map `lib/emailDraftStore.ts` writes, redeclared here rather than imported
 * because that module pulls in the DynamoDB client and this type is used by client components.
 */
export interface EmailDraft {
  /**
   * Always null. Kept in the type because the attribute is written as NULL, so code that reads it can
   * see it is never an address — the recipient is `recipient_contact_id`, resolved at send time.
   */
  recipient: string | null;
  /** Which contact receives this. The authority for the recipient; the hint below is prose. */
  recipient_contact_id?: string;
  /** Who the model believes it is writing to. Display only; never used as an address. */
  recipient_hint?: string;
  /** Which template produced the rendered subject and body, and the values substituted into it. */
  template_id?: string;
  variables?: Record<string, string>;
  subject: string;
  body: string;
  /** Non-null only when `draft_status` is `render_failed`; names the variable that went missing. */
  render_error?: string | null;
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
  classification_reasoning?: string;
  resolution?: string;
  confidence?: string;
  // Evidence-completeness breakdown: which of the skill's prescribed steps obtained data.
  confidence_components?: {
    skill?: string;
    prescribed?: number;
    // NOTE: a COUNT here, whereas `ReasoningStep.satisfied` above is a per-step boolean. Same word,
    // two types, both present on the same case payload — do not copy one into the other.
    satisfied?: number;
    unsatisfied_step_ids?: string[];
    unattempted_step_ids?: string[];
    // Ids the agent reported that the skill never declared. Ignored for scoring rather than fatal —
    // see backend/recon_core/confidence.evidence_completeness. Not a subset of the two lists above:
    // these ids are, by definition, not prescribed steps at all.
    undeclared_step_ids?: string[];
    // Set instead of the counts when the classified skill prescribes no steps (e.g. `unknown`).
    unscoreable?: string;
  };
  steps?: ReasoningStep[];
  // Why the investigation died, written by the agent worker when it escalates the case to FAILED.
  // Only meaningful while `status === "FAILED"`: a retry moves the case back to IN_PROGRESS without
  // clearing these, so the UI must gate on the status rather than on their presence.
  failure_reason?: string;
  failed_at?: string;
  // Structured executable action the agent derived (null when nothing was safely actionable).
  proposed_action?: Record<string, unknown> | null;
  // Counterparty email the agent drafted, if it proposed writing to anyone. Absent on most cases.
  proposed_email?: EmailDraft | null;
  // Full nested item as stored (carries attributes.idp_* from the hook).
  item?: { attributes?: IdpDetail & Tier1Detail; source_refs?: string[] };
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

// Manual submission from the queue's "Create New" action. Goes through the intake Lambda (see
// /api/recon/items), so the payload is validated by the same pydantic model the pipeline uses —
// which is also why a rejected payload arrives here as a thrown error carrying intake's message.
export async function createReconItems(payload: {
  domain: string;
  items: Record<string, unknown>[];
}): Promise<{ written: number }> {
  return json(
    await reconFetch(`/api/recon/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
 * Replace the draft's recipient contact, subject and body, returning it at its new revision.
 *
 * @param id - the case id.
 * @param draft - the edited fields plus the `revision` being edited. `recipient_contact_id` rather
 *   than an address: the browser never handles one, and the id is what makes a later deactivation
 *   revoke this draft.
 * @returns the stored draft — `pending` again, since an edit revokes any approval.
 */
export async function saveEmailDraft(
  id: string,
  draft: {
    recipient_contact_id: string;
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
  // Evidence-completeness threshold for straight-through processing; null = disabled.
  autoResolveThreshold: number | null;
  // Decision-comment requirement on approve/disapprove.
  commentRequirement: "required" | "optional" | "disapprove-only";
  // Tier-2 agent backend: container Runtime or managed Harness (runtime-switchable).
  agentBackend: "runtime" | "harness";
  // Domains a counterparty email may be addressed to. READ-ONLY here: it comes from the deploy's
  // environment (terraform `counterparty_email_domains`), and the BFF rejects an attempt to PUT it
  // rather than accepting a change the interceptor would not honor. Empty means no counterparty
  // email can be sent at all.
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
  src?: "tier1" | "agent" | "guard",
): Promise<LambdaSourceFile[]> {
  // "tier1" is the route's default prefix, so it is passed as no query string at all.
  const q = src && src !== "tier1" ? `?src=${src}` : "";
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

// --- Contacts and email templates ---------------------------------------------------------------
//
// Two audiences, two shapes. An ANALYST picking a recipient gets {@link ContactSummary} from
// `/api/recon/contacts` with no address in it. An OPERATOR maintaining the list gets the whole row,
// addresses and deactivated entries included, from `/api/recon/config/contacts` — that is the audience
// that owns the list, and hiding a deactivated row from them would turn "revoked" into "never existed".

/** What the draft panel's picker needs: who, and whether they can be picked. Never an address. */
export interface ContactSummary {
  contact_id: string;
  display_name: string;
  kind: string;
  active: boolean;
}

/** A full contact row, as the Config tab edits it. */
export interface Contact extends ContactSummary {
  email: string;
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

/** An email template. `variables` is the declared set; the server refuses a body using any other. */
export interface EmailTemplate {
  template_id: string;
  name: string;
  purpose: string;
  subject_template: string;
  body_template: string;
  variables: string[];
  active: boolean;
  /** Bumped on every save. Shown so an operator can tell a template has been edited since. */
  revision: number;
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

/**
 * Active contacts for a picker, addresses withheld.
 *
 * @param kind - optional filter, e.g. `"counterparty"`.
 * @returns the summaries.
 */
export async function listContactSummaries(
  kind?: string,
): Promise<ContactSummary[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const body = await json<{ contacts: ContactSummary[] }>(
    await reconFetch(`/api/recon/contacts${qs}`),
  );
  return body.contacts;
}

/** Every contact including deactivated ones, for the Config tab. */
export async function listContacts(): Promise<Contact[]> {
  const body = await json<{ contacts: Contact[] }>(
    await reconFetch(`/api/recon/config/contacts`),
  );
  return body.contacts;
}

/**
 * A stored contact, plus anything the server wants said about it that is not an error.
 *
 * `warning` carries the one consequence a successful write can have: a counterparty address outside
 * the deployment's allowed domains is on the list and will be refused at send. It is a second return
 * value rather than a thrown error because the write SUCCEEDED — throwing would make the panel report
 * a failed save of a row that now exists.
 */
export interface ContactWriteResult {
  contact: Contact;
  warning: string | null;
}

/** Create one contact. The server generates the id when `contact_id` is omitted. */
export async function createContact(contact: {
  contact_id?: string;
  display_name: string;
  email: string;
  kind: string;
}): Promise<ContactWriteResult> {
  const body = await json<{ contact: Contact; warning?: string | null }>(
    await reconFetch(`/api/recon/config/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contact),
    }),
  );
  return { contact: body.contact, warning: body.warning ?? null };
}

/** Edit one contact. Omitted fields keep their stored value. */
export async function updateContact(
  contactId: string,
  fields: {
    display_name?: string;
    email?: string;
    kind?: string;
    active?: boolean;
  },
): Promise<ContactWriteResult> {
  const body = await json<{ contact: Contact; warning?: string | null }>(
    await reconFetch(
      `/api/recon/config/contacts/${encodeURIComponent(contactId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      },
    ),
  );
  return { contact: body.contact, warning: body.warning ?? null };
}

/**
 * Deactivate one contact — a soft delete, so historical drafts citing it still read correctly.
 *
 * Answers 409 for the last active `internal_notification` contact, since removing it would stop every
 * resolution notification. Surface that message; it tells the operator to add a replacement first.
 */
export async function deactivateContact(contactId: string): Promise<Contact> {
  const body = await json<{ contact: Contact }>(
    await reconFetch(
      `/api/recon/config/contacts/${encodeURIComponent(contactId)}`,
      { method: "DELETE" },
    ),
  );
  return body.contact;
}

/** Every template including deactivated ones, for the Config tab. */
export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const body = await json<{ templates: EmailTemplate[] }>(
    await reconFetch(`/api/recon/config/templates`),
  );
  return body.templates;
}

/** Create one template. Refused with 400 if the text uses a placeholder not in `variables`. */
export async function createEmailTemplate(template: {
  template_id?: string;
  name: string;
  purpose: string;
  subject_template: string;
  body_template: string;
  variables: string[];
}): Promise<EmailTemplate> {
  const body = await json<{ template: EmailTemplate }>(
    await reconFetch(`/api/recon/config/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
    }),
  );
  return body.template;
}

/** Edit one template. Omitted fields keep their stored value; the revision is bumped either way. */
export async function updateEmailTemplate(
  templateId: string,
  fields: {
    name?: string;
    purpose?: string;
    subject_template?: string;
    body_template?: string;
    variables?: string[];
    active?: boolean;
  },
): Promise<EmailTemplate> {
  const body = await json<{ template: EmailTemplate }>(
    await reconFetch(
      `/api/recon/config/templates/${encodeURIComponent(templateId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      },
    ),
  );
  return body.template;
}

/**
 * Deactivate one template — a soft delete, for the same reason as contacts.
 *
 * No last-one-standing guard on this side: a case whose template is gone gets a visible
 * `render_failed` draft naming the problem, which is a symptom an operator can act on.
 */
export async function deactivateEmailTemplate(
  templateId: string,
): Promise<EmailTemplate> {
  const body = await json<{ template: EmailTemplate }>(
    await reconFetch(
      `/api/recon/config/templates/${encodeURIComponent(templateId)}`,
      { method: "DELETE" },
    ),
  );
  return body.template;
}

// --- Workflow types -----------------------------------------------------------------------------

// What an operator may upload, and where each kind of upload goes. `route` is the field that decides:
// an `extraction` type is turned into a structured notice against the pinned `idp_config_version`, a
// `knowledge-base` type is ingested as guidance under `kb_doc_type`. The two are mutually exclusive
// and the server refuses a row that claims both or neither.

export interface WorkflowType {
  workflow_type_id: string;
  display_name: string;
  route: "extraction" | "knowledge-base";
  /** Required on an extraction route, and must be empty on a knowledge-base route. */
  idp_config_version: string;
  /** `email` or `email_attachment` on a knowledge-base route; empty on an extraction route. */
  kb_doc_type: string;
  description?: string;
  extra_metadata?: Record<string, string>;
  active: boolean;
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

/** Every workflow type including retired ones, for the Config tab. */
export async function listWorkflowTypes(): Promise<WorkflowType[]> {
  const body = await json<{ workflowTypes: WorkflowType[] }>(
    await reconFetch(`/api/recon/config/workflow-types`),
  );
  return body.workflowTypes;
}

/**
 * Create one workflow type.
 *
 * Answers 400 when the route and the route-specific fields disagree — most usefully when an
 * extraction type is saved with no version pinned, which downstream would not fail at all: the
 * document pipeline would extract against whichever configuration happened to be active.
 */
export async function createWorkflowType(workflowType: {
  workflow_type_id: string;
  display_name: string;
  route: string;
  idp_config_version?: string;
  kb_doc_type?: string;
  description?: string;
  extra_metadata?: Record<string, string>;
}): Promise<WorkflowType> {
  const body = await json<{ workflowType: WorkflowType }>(
    await reconFetch(`/api/recon/config/workflow-types`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workflowType),
    }),
  );
  return body.workflowType;
}

/**
 * Edit one workflow type. Omitted fields keep their stored value, but the row is re-validated whole.
 *
 * That matters when switching route: changing `route` to `knowledge-base` without also clearing
 * `idp_config_version` is refused, because the stored version would otherwise sit on a type that no
 * longer reaches extraction.
 */
export async function updateWorkflowType(
  workflowTypeId: string,
  fields: {
    display_name?: string;
    route?: string;
    idp_config_version?: string;
    kb_doc_type?: string;
    description?: string;
    extra_metadata?: Record<string, string>;
    active?: boolean;
  },
): Promise<WorkflowType> {
  const body = await json<{ workflowType: WorkflowType }>(
    await reconFetch(
      `/api/recon/config/workflow-types/${encodeURIComponent(workflowTypeId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      },
    ),
  );
  return body.workflowType;
}

/**
 * Retire one workflow type — a soft delete, so documents already uploaded under it still explain
 * which extraction configuration they were processed against.
 */
export async function deactivateWorkflowType(
  workflowTypeId: string,
): Promise<WorkflowType> {
  const body = await json<{ workflowType: WorkflowType }>(
    await reconFetch(
      `/api/recon/config/workflow-types/${encodeURIComponent(workflowTypeId)}`,
      { method: "DELETE" },
    ),
  );
  return body.workflowType;
}

// --- Uploads recon sent ---------------------------------------------------------------------------

/** One file of a submission, as the audit table recorded it. */
export interface SubmissionFileRow {
  filename: string;
  object_key: string;
  status: "PENDING" | "UPLOADED" | "PENDING_INGESTION" | "INGESTED" | "FAILED";
  size_bytes: number;
  derived_object_keys?: string[];
  error?: string;
}

/** One upload submission. */
export interface SubmissionRow {
  submission_id: string;
  workflow_type: string;
  route: "extraction" | "knowledge-base";
  config_version: string;
  uploaded_by: string;
  uploaded_at: string;
  status_updated_at?: string;
  files: SubmissionFileRow[];
}

/**
 * Read recent upload submissions, newest first.
 *
 * @param limit - How many to ask for. The route clamps this at 100.
 * @returns The submissions.
 */
export async function listSubmissions(limit = 25): Promise<SubmissionRow[]> {
  const body = await json<{ submissions: SubmissionRow[] }>(
    await reconFetch(`/api/recon/uploads?limit=${limit}`),
  );
  return body.submissions;
}

/**
 * Upload files.
 *
 * @param form - The multipart body. Build it with `FormData`, one `files` entry per file plus the
 *   descriptors the route expects: `route`, `workflowTypeId`, `configVersion`, `docType`,
 *   `breakClasses`, `skills`, `subject`.
 * @returns The submission id and one result row per file. A file that was refused comes back
 *   FAILED with an `error` rather than throwing, so a bad file does not hide the good ones.
 */
export async function uploadFiles(
  form: FormData,
): Promise<{ submissionId: string; files: SubmissionFileRow[] }> {
  // No Content-Type header. The browser has to set it itself, because only the browser knows the
  // multipart boundary it generated. Setting it by hand produces a body the server cannot parse.
  return json(
    await reconFetch(`/api/recon/uploads`, { method: "POST", body: form }),
  );
}

// --- Documents processed by the pipeline ---------------------------------------------------------

// Read-only. Every field is nullable because the pipeline fills them in as it goes: a row that has only
// just arrived carries a key, a start time, and little else.
//
// There is no production/test filter and no total count. The upstream API offers neither — see the
// route's own comment — so a caller that wants "how many" gets the length of what came back.

export interface IdpDocument {
  ObjectKey: string | null;
  ObjectStatus: string | null;
  WorkflowStatus: string | null;
  InitialEventTime: string | null;
  QueuedTime: string | null;
  CompletionTime: string | null;
  /** The extraction configuration the pipeline actually used. The column the Documents tab exists for. */
  ConfigVersion: string | null;
  EvaluationStatus: string | null;
  HITLStatus: string | null;
  HITLTriggered: boolean | null;
  HITLCompleted: boolean | null;
  HITLReviewOwner: string | null;
  HITLReviewedBy: string | null;
  PageCount: number | null;
  ConfidenceAlertCount: number | null;
}

/** A per-attribute confidence alert — the detail behind `ConfidenceAlertCount`. */
export interface IdpConfidenceAlert {
  attributeName: string | null;
  confidence: number | null;
  confidenceThreshold: number | null;
}

/** One classified span of a document, with the alerts raised while extracting it. */
export interface IdpDocumentSection {
  Id: string | null;
  Class: string | null;
  Excluded: boolean | null;
  ExclusionReason: string | null;
  PageIds: number[] | null;
  ConfidenceThresholdAlerts: IdpConfidenceAlert[] | null;
}

export interface IdpDocumentDetail extends IdpDocument {
  WorkflowExecutionArn: string | null;
  /** A deep link into the pipeline's own review UI. Absent unless a review was triggered. */
  HITLReviewURL: string | null;
  Sections: IdpDocumentSection[] | null;
  Pages: { Id: number | null; Class: string | null }[] | null;
}

export interface IdpDocumentPage {
  documents: IdpDocument[];
  nextToken: string | null;
  count: number;
  /** The window the server actually read, which is not always the one the caller asked for. */
  window: { startDateTime: string; endDateTime: string };
}

/**
 * One page of processed documents.
 *
 * @param opts.startDateTime - ISO-8601 window start; the server defaults to 30 days back when omitted.
 * @param opts.endDateTime - ISO-8601 window end; defaults to now.
 * @param opts.limit - rows per page, clamped server-side to 100.
 * @param opts.nextToken - continuation token from a previous page.
 */
export async function listIdpDocuments(opts?: {
  startDateTime?: string;
  endDateTime?: string;
  limit?: number;
  nextToken?: string | null;
}): Promise<IdpDocumentPage> {
  const qs = new URLSearchParams();
  if (opts?.startDateTime) qs.set("startDateTime", opts.startDateTime);
  if (opts?.endDateTime) qs.set("endDateTime", opts.endDateTime);
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.nextToken) qs.set("nextToken", opts.nextToken);
  return json<IdpDocumentPage>(
    await reconFetch(
      `/api/recon/idp-documents${qs.size ? `?${qs.toString()}` : ""}`,
    ),
  );
}

/**
 * One document in full, including its sections and their confidence alerts.
 *
 * @param objectKey - the raw object key. Encoded once here; the route does not decode it again.
 */
export async function getIdpDocument(
  objectKey: string,
): Promise<IdpDocumentDetail> {
  const body = await json<{ document: IdpDocumentDetail }>(
    await reconFetch(
      `/api/recon/idp-documents/${encodeURIComponent(objectKey)}`,
    ),
  );
  return body.document;
}
