variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared backend Lambda deployment zip (from the lambda-package module)."
  type        = string
}
variable "lambda_source_hash" {
  description = "Base64 SHA-256 of the shared Lambda zip (from the lambda-package module)."
  type        = string
}

variable "items_stream_arn" {
  description = "DynamoDB stream ARN of the recon-items table (Tier-1 trigger)."
  type        = string
}

variable "items_table_arn" {
  description = "ARN of the recon-items table (read access for Tier-1)."
  type        = string
}

variable "cases_table" {
  description = "Name of the recon-cases table."
  type        = string
}

variable "cases_table_arn" {
  description = "ARN of the recon-cases table."
  type        = string
}

variable "audit_table" {
  description = "Name of the recon-audit table."
  type        = string
}

variable "audit_table_arn" {
  description = "ARN of the recon-audit table."
  type        = string
}

variable "agent_runtime_arn" {
  description = "ARN of the recon-agent AgentCore runtime (from the recon-agent module). Empty on first apply."
  type        = string
  default     = ""
}

variable "tier1_enabled_param" {
  description = "Name of the SSM parameter toggling the deterministic Tier-1 route."
  type        = string
}

variable "tier1_enabled_param_arn" {
  description = "ARN of the Tier-1 toggle SSM parameter (for read IAM)."
  type        = string
}

variable "ingress_gateway_url" {
  description = "Ingress AgentCore gateway base URL fronting the agent runtime. When set with use_ingress_gateway, the worker invokes the agent through the gateway (SigV4) instead of a direct InvokeAgentRuntime."
  type        = string
  default     = ""
}

variable "ingress_gateway_arn" {
  description = "Ingress gateway ARN — the worker role is granted bedrock-agentcore:InvokeGateway on it."
  type        = string
  default     = ""
}

variable "use_ingress_gateway" {
  description = "Route agent invocations through the ingress gateway (true) or via direct InvokeAgentRuntime (false). Takes effect only alongside ingress_gateway_url: true with an empty URL falls straight through to the direct path. A failure proving the request never ran — a signing or URL error, or an HTTP status from the gateway — falls back to a direct invoke, so a misconfigured gateway or policy cannot strand escalated items. A timeout does NOT fall back: the request was delivered and the investigation is still executing, so the worker re-raises rather than starting a second multi-minute investigation of the same item."
  type        = bool
  default     = false
}

variable "ingress_target_name" {
  description = "Ingress gateway target name fronting the runtime (invocation path {gateway}/{target}/invocations)."
  type        = string
  default     = "recon-agent"
}

variable "gl_query_function_name" {
  description = "gl-query Lambda name for the deterministic GL lookup ('' disables)."
  type        = string
  default     = ""
}

variable "gl_query_function_arn" {
  type    = string
  default = ""
}

variable "vpc_subnet_ids" {
  description = "Private subnets to attach the Lambda(s) to ([] = no VPC)."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}

# --- Harness backend (AGENT_BACKEND="harness") ---
variable "agent_backend" {
  description = "Agent invocation backend: 'runtime' or 'harness'."
  type        = string
  default     = "runtime"
}

variable "harness_arn" {
  description = "AgentCore Harness ARN (used when agent_backend='harness'). Empty when unused."
  type        = string
  default     = ""
}

variable "harness_model_id" {
  description = "Bedrock model id/inference profile for the harness."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "system_prompt_key" {
  description = "S3 key of the SHARED system-prompt core, read by both Tier-2 backends."
  type        = string
  default     = "system-prompt.md"
}

variable "harness_system_prompt_key" {
  description = "S3 key of the harness-only calling contract, appended after the shared core."
  type        = string
  default     = "system-prompt-harness.md"
}

variable "assets_bucket" {
  description = "Assets bucket (harness worker reads the skills catalog + system prompt)."
  type        = string
  default     = ""
}

variable "assets_bucket_arn" {
  type    = string
  default = ""
}

variable "skills_prefix" {
  description = "S3 prefix for skills."
  type        = string
  default     = "skills/"
}

variable "lessons_table" {
  description = "recon-lessons table name (AUTO_RESOLVED lessons + recall)."
  type        = string
  default     = ""
}

variable "lessons_table_arn" {
  type    = string
  default = ""
}

variable "memory_id" {
  description = "AgentCore Memory id for worker-side lesson recall ('' disables)."
  type        = string
  default     = ""
}

variable "memory_arn" {
  type    = string
  default = ""
}

variable "auto_resolve_param" {
  description = "SSM parameter name of the auto-resolve threshold (harness worker reads it)."
  type        = string
  default     = ""
}

variable "harness_config_version_param" {
  description = "SSM parameter name of the active harness config version pointer."
  type        = string
  default     = ""
}

variable "agent_backend_param" {
  description = "SSM parameter name of the runtime agent-backend selector (runtime|harness)."
  type        = string
  default     = ""
}

variable "agent_model_id_param" {
  description = "SSM parameter name of the live Tier-2 model selection. Empty means unwired, and the worker keeps using HARNESS_MODEL_ID without attempting a read."
  type        = string
  default     = ""
}

variable "egress_gateway_arn" {
  description = "Egress tools gateway ARN — the harness-backend worker executes the Policy-gated set_draw_status write through it ('' skips the grant)."
  type        = string
  default     = ""
}

variable "egress_gateway_url" {
  description = "Egress tools gateway URL for the worker's gateway write + resolution email (RECON_GATEWAY_URL)."
  type        = string
  default     = ""
}

variable "graph_mailbox" {
  description = "Shared mailbox the worker's resolution email is sent FROM (empty disables the email step)."
  type        = string
  default     = ""
}

variable "notify_contact_id" {
  description = <<-EOT
    Contact ID of the internal-notification recipient for auto-resolve emails (empty disables the
    email step). Deliberately an ID and not an address: the worker looks the address up in
    contacts_table at send time and refuses the send if the contact is missing, deactivated, or of
    the wrong kind. An address baked in here could not be revoked without a redeploy.
  EOT
  type        = string
  default     = ""
}

variable "contacts_table" {
  description = "Contacts table the worker resolves notify_contact_id against (needs GetItem)."
  type        = string
  default     = ""
}

variable "contacts_table_arn" {
  description = "ARN of the contacts table, for the worker role's read grant."
  type        = string
  default     = ""
}

variable "email_confirmation_token" {
  description = "Shared secret for the auto-resolve email send (gateway interceptor human-confirmation gate)."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------------
# Client-side OTel tracing for the agent-worker Lambda
# ---------------------------------------------------------------------------------

variable "otel_layer_arn" {
  description = <<-EOT
    ADOT Lambda layer ARN (AWSOpenTelemetryDistroPython) for the agent-worker. This layer is the
    ONLY source of the opentelemetry packages — they are not vendored into the shared Lambda zip.
    Empty = tracing fully off: no layer, no OTel env, PassThrough X-Ray, and the
    backend/recon_core/otel_client helpers stay inert.
  EOT
  type        = string
  default     = ""
}

variable "otel_baggage_span_attribute_keys" {
  description = <<-EOT
    Allow-list of W3C baggage keys promoted to span attributes. Must match the harness module's
    variable of the same name — the keys are set on this side and consumed on the other, so a
    mismatch silently drops attributes from the agent's spans.
  EOT
  type        = string
  default     = "harness.id,harness.endpoint.qualifier,session.id,recon.item_id,recon.domain,recon.backend"
}

variable "workflow_types_table" {
  description = "Name of the recon-workflow-types table, read when deciding whether the knowledge-base route counts as an evidence source. Empty disables the lookup, which resolves to NOT enabled."
  type        = string
  default     = ""
}

variable "workflow_types_table_arn" {
  description = "ARN of the recon-workflow-types table, for the Scan grant. Empty when the lookup is disabled."
  type        = string
  default     = ""
}

variable "max_concurrent_investigations" {
  description = <<-EOT
    Reserved concurrency for the agent-worker: the ceiling on simultaneous Tier-2 investigations.
    NOT a tuning knob, and bounded on BOTH sides.

    Upper bound ~28 — the 6M tokens/min account quota for the Sonnet inference profile divided by one
    run's token rate (~200k tokens over ~57s ≈ 214k tokens/min). Exceed it and every request throttles,
    which is the failure this variable exists to prevent.

    Lower bound 14 — capped invocations wait in the Lambda async queue, which discards at
    maximum_event_age_in_seconds (6h service max). 5000 escalations at ~57s each need >= 14 slots to
    drain inside 6h. Set it lower and the tail of a full burst expires with no case row and no
    proposal: a throttling failure traded for a DATA-LOSS one.

    Sits near the floor on purpose. The upper bound is only mean-derived, from five synthetic
    same-minute QA cases — the sample that existed when this shipped. Re-derive from >= 30 real cases
    at p95, not the mean: tokens arrive in bursts per Converse call and the context grows across turns,
    so a mean under-counts synchronised peaks against a per-minute quota. Re-check whenever the quota,
    the token profile, or the prompt-cache hit rate moves.
  EOT
  type        = number
  default     = 14

  validation {
    # The floor is not advisory: below it the tail of a full burst outlives the async queue.
    condition     = var.max_concurrent_investigations >= 14
    error_message = "max_concurrent_investigations must be >= 14, or a 5000-escalation burst expires in the Lambda async queue before it drains."
  }
}

variable "tier2_state_machine_arn" {
  description = <<-EOT
    Tier-2 map-run state machine, nudged once per batch when this consumer opens an escalated case, so a
    submission is investigated in seconds rather than at the next scheduled tick.

    Empty disables the nudge and leaves the schedule as the only trigger -- correct, but slow. This is
    NOT a return to dispatching from the stream: what starts is the bounded runner, whose single-flight
    guard makes every start beyond the first a no-op, and whose MaxConcurrency remains the only thing
    deciding how many agents run at once.
  EOT
  type        = string
  default     = ""
}
