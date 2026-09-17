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

export interface ParseOutput {
  fields: FieldValues;
  evidence: Record<string, FieldEvidence>;
  assumptions: string[];
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
    | "REJECTED";
  detail?: string;
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

export interface MemoryRecord {
  id: string;
  namespace: string;
  content: string;
  createdAt: string;
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
