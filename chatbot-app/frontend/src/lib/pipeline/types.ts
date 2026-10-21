// Shared wire types for the deal pipeline BFF (`/api/pipeline/*`) and its UI.
// Contract: docs/deal-pipeline-design.md §4, §7, §9. Keep in sync with backend/deal_pipeline.

export type SourceKind = "news-alert" | "bank-notice" | "manual";

export type EmailStatus = "RECEIVED" | "PARSING" | "PARSED" | "PARSE_FAILED";

export type DealStatus =
  | "STAGED"
  | "APPROVED"
  | "UPLOADED"
  | "UPLOAD_FAILED"
  | "REJECTED";

export type Confidence = "high" | "medium" | "low";

/** Every OMS field key maps to its formatted string value; "" when blank. */
export type FieldValues = Record<string, string>;

export interface FieldEvidence {
  value: string;
  confidence: Confidence;
  /** The email text the value was taken from. */
  excerpt: string;
  /** Skill or memory rule the agent applied, when any. */
  rule?: string;
}

export interface MemoryHit {
  record_id?: string;
  text: string;
}

export interface Enrichment {
  issuer_match: string | null;
  fields_from_security_master: string[];
}

/**
 * One order of a parse that staged several (design §15): an instrument the email offers now, with
 * its complete field set — shared values repeated — its evidence and its assumptions.
 */
export interface ParsedOrder {
  label: string;
  fields: FieldValues;
  evidence: Record<string, FieldEvidence>;
  assumptions: string[];
}

export interface ParseOutput {
  /** The first order's values: the whole parse for a single-order email. */
  fields: FieldValues;
  evidence: Record<string, FieldEvidence>;
  assumptions: string[];
  /** Present only when the email offers more than one instrument; read through `parsedOrdersOf`. */
  orders?: ParsedOrder[];
  memory_hits: MemoryHit[];
  skills_used: string[];
  enrichment: Enrichment;
  model_id: string;
  duration_ms: number;
}

export interface EmailRecord {
  email_id: string;
  received_at: string;
  source_kind: SourceKind;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  sent: string;
  body: string;
  sample_id: string | null;
  status: EmailStatus;
  deal_id: string | null;
  parse: ParseOutput | null;
  error: string | null;
  updated_at: string;
}

export interface UploadError {
  code: string;
  field: string | null;
  message: string;
  hint?: string;
  /** In a file of several orders, the 0-based row (order index) the error came from. */
  row?: number;
}

export interface UploadResult {
  attempted_at: string;
  accepted: boolean;
  staging_key: string | null;
  errors: UploadError[];
  validator_version: string;
}

export interface DealHistoryEntry {
  at: string;
  actor: string;
  action:
    | "STAGED"
    | "EDITED"
    | "APPROVED"
    | "UPLOAD_ACCEPTED"
    | "UPLOAD_REJECTED"
    | "REJECTED"
    | "LESSON_RETRACTED";
  detail?: string;
}

/**
 * Where an override was made: reviewing a freshly staged deal, or fixing a deal the OMS rejected
 * (a "break"). The break case carries the rejection codes that named the field, so the lesson the
 * memory extracts can say which OMS rule the correction satisfies.
 */
export type OverrideStage = "review" | "break";

/**
 * Whether an override reached the knowledge memory as a lesson.
 *
 * `pending` between the deal write and the memory write (and left there only if recording the
 * outcome lost a race); `off` when no knowledge memory is deployed; `retracted` once the lesson's
 * record was deleted — by its author or an admin, from the deal or from the Memory Manager. The
 * override itself, and the value it set, stay.
 */
export interface OverrideMemory {
  status: "pending" | "sent" | "failed" | "off" | "retracted";
  event_id?: string;
  error?: string;
  retracted_by?: string;
  retracted_at?: string;
}

/** One reviewer's change to one field, with the reason they gave (design §4). Append-only. */
export interface FieldOverride {
  override_id: string;
  field: string;
  /** The parser's value (`original_fields`), for the lesson and the "as parsed" view. */
  parsed_value: string;
  /** The value this override replaced — the parser's, or an earlier override's. */
  previous_value: string;
  value: string;
  reason: string;
  actor: string;
  at: string;
  stage: OverrideStage;
  /** Break stage only: codes of the last rejected upload that named this field. */
  upload_error_codes?: string[];
  /**
   * The orders this override changed (indexes into `orders`). Absent on a single-order deal, which
   * reads as `[0]` — see `overrideOrders`. One override covering several orders sends one lesson.
   */
  order_indexes?: number[];
  memory: OverrideMemory;
}

/**
 * One order of a deal that stages several (design §15): one row of the deal's staging file, with
 * its own values, its as-parsed values and its evidence. Approval, upload and rejection stay with
 * the deal — the file is one unit per email.
 */
export interface DealOrder {
  label: string;
  fields: FieldValues;
  original_fields: FieldValues;
  evidence: Record<string, FieldEvidence>;
  assumptions?: string[];
}

export interface DealRecord {
  deal_id: string;
  email_id: string;
  opportunity_name: string;
  status: DealStatus;
  fields: FieldValues;
  original_fields: FieldValues;
  evidence: Record<string, FieldEvidence>;
  assumptions: string[];
  memory_hits: MemoryHit[];
  skills_used: string[];
  enrichment: Enrichment;
  csv_key: string;
  upload: UploadResult | null;
  history: DealHistoryEntry[];
  /** Absent on deals staged before overrides existed; read it through `overridesOf`. */
  overrides?: FieldOverride[];
  /**
   * Present only when the email offered more than one instrument; read through `ordersOf`. The
   * top-level `fields`, `original_fields` and `evidence` are then the first order's, kept in step
   * by every writer.
   */
  orders?: DealOrder[];
  created_at: string;
  updated_at: string;
}

export interface SampleEmail {
  id: string;
  subject: string;
  source_kind: SourceKind;
  sent: string;
  from: string;
}

export type ProposalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface SkillProposal {
  proposal_id: string;
  skill_name: string;
  summary: string;
  rationale: string;
  proposed_content: string;
  current_content: string;
  status: ProposalStatus;
  source: { kind: "assistant" | "manual"; session_id?: string; deal_id?: string };
  created_at: string;
  decided_at?: string;
  decided_by?: string;
}

/**
 * Where a lesson came from: the override whose provenance (override id, author, deal) the strategy
 * copied onto the record, joined by the BFF with that override on its deal.
 */
export interface LessonSource {
  kind: "override";
  override_id: string;
  author: string;
  deal_id: string;
  /** From the override on the deal; absent when the deal or override can no longer be read. */
  field?: string;
  opportunity_name?: string;
  reason?: string;
  at?: string;
}

export interface MemoryRecord {
  id: string;
  namespace: string;
  content: string;
  createdAt: string;
  /** Provenance metadata on the record, as stored (see `LessonSource`). */
  metadata?: Record<string, string>;
  /**
   * Present for a lesson an override taught; absent for a rule saved by hand, by the assistant, or
   * by an override made before provenance was recorded.
   */
  source?: LessonSource;
}

export interface OmsFieldDef {
  key: string;
  label: string;
  section: string;
  type:
    | "date"
    | "time"
    | "percent"
    | "mm"
    | "price"
    | "integer"
    | "boolean"
    | "enum"
    | "string";
  values?: string[];
  source: "email" | "lookup" | "internal" | "post_pricing";
  required: boolean;
  default?: string;
  notes?: string;
  max_length?: number;
  pattern?: string;
  min?: number;
  max?: number;
}

export interface OmsSchema {
  sections: string[];
  fields: OmsFieldDef[];
}

/** One `data:` line of the assistant stream (design §7). */
export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "done"; session_id: string }
  | { type: "error"; message: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Tool activity rendered inline under an assistant turn. */
  tools?: { name: string; ok: boolean; summary: string }[];
  at: string;
}
