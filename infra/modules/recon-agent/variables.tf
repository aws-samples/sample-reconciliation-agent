variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
}

variable "agent_src_dir" {
  description = "Absolute path to agent-blueprint/recon-agent (container build context)."
  type        = string
}

variable "cases_table" {
  description = "Name of the recon-cases table (agent persists proposals here)."
  type        = string
}

variable "cases_table_arn" {
  type = string
}

variable "audit_table" {
  description = "Name of the recon-audit table."
  type        = string
}

variable "audit_table_arn" {
  type = string
}

variable "assets_bucket" {
  description = "Assets bucket that holds the published skills-catalog.json and KB seed corpus."
  type        = string
}

variable "assets_bucket_arn" {
  type = string
}

variable "idp_gateway_target_url" {
  description = "Independently-deployed IDP (document-extraction) endpoint to register as a Gateway target. Empty disables it."
  type        = string
  default     = ""
}

variable "idp_mcp_secret_json" {
  description = "JSON {token_url, client_id, client_secret, scope} for IDP MCP client-credentials. Empty disables the secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "model_id" {
  description = "Bedrock model (or inference-profile) id the agent's classify/investigate loop calls."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "auto_resolve_param" {
  description = "SSM parameter name holding the auto-resolve confidence threshold."
  type        = string
}

variable "auto_resolve_param_arn" {
  type = string
}

variable "lessons_table" {
  description = "recon-lessons table (AUTO_RESOLVED lessons)."
  type        = string
}

variable "lessons_table_arn" {
  type = string
}

variable "interceptor_mode" {
  description = "Gateway REQUEST interceptor mode: 'log' (observe only, never blocks) or 'enforce' (reject failing provenance/transition checks). Roll out log -> enforce."
  type        = string
  default     = "log"

  validation {
    condition     = contains(["log", "enforce"], var.interceptor_mode)
    error_message = "interceptor_mode must be 'log' or 'enforce'."
  }
}

variable "email_confirmation_token" {
  description = "Shared secret the gateway interceptor requires on sendSharedMailboxMail calls (human-confirmation gate). Provisioned to platform send paths + the interceptor, never surfaced to the model. Empty disables the gate (interceptor treats every send as unconfirmed)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "counterparty_email_domains" {
  description = "Domains a `counterparty` send may be addressed to, joined into the interceptor's COUNTERPARTY_EMAIL_DOMAINS. Empty allows no counterparty send at all — the fail-safe direction for this control is sending nothing."
  type        = list(string)
  default     = []
}

variable "platform_role_names" {
  description = "IAM role NAMES of platform principals permitted to call the platform-only recon_update_status gateway tool (e.g. the frontend ECS task role). Empty list means nobody is permitted (fail-closed)."
  type        = list(string)
  default     = []
}

variable "agent_role_names" {
  description = "IAM role NAMES of agent-side principals explicitly forbidden from recon_update_status (harness execution role, agent-worker role). The runtime execution role is added in-module."
  type        = list(string)
  default     = []
}

variable "notify_email" {
  description = "Recipient for auto-resolve notification emails, sent from the shared mailbox via the microsoft-graph gateway tool (empty disables)."
  type        = string
  default     = ""
}

# Every caller passes this explicitly (environments/recon/main.tf), so the module needs no
# default — and a real mailbox address does not belong in committed code.
variable "graph_mailbox" {
  description = "Shared mailbox SMTP address the agent's Graph email tools send from / read. Must be a real mailbox in the Entra tenant with Mail.Send/Mail.Read app access. Empty disables the email step."
  type        = string
}

variable "lambda_zip" {
  description = "Shared backend Lambda deployment zip (kb-search tool)."
  type        = string
}

variable "lambda_source_hash" {
  type = string
}

variable "gl_tool_lambda_arn" {
  description = "ARN of the gl-query Lambda registered as the general-ledger Gateway tool ('' disables)."
  type        = string
  default     = ""
}

variable "vpc_subnet_ids" {
  description = "Private subnets for the kb-search Lambda + VPC-mode AgentCore Runtime ([] = public)."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}

variable "gl_tool_enabled" {
  description = "Register the general-ledger Gateway target (static gate; pair with gl_tool_lambda_arn)."
  type        = bool
  default     = false
}

variable "set_draw_status_lambda_arn" {
  description = "ARN of the set-draw-status write Lambda registered as the set-draw-status Gateway tool ('' disables)."
  type        = string
  default     = ""
}

variable "set_draw_status_enabled" {
  description = "Register the set-draw-status Gateway target (static gate; pair with set_draw_status_lambda_arn). Static bool so `count` never depends on a computed ARN."
  type        = bool
  default     = false
}

variable "confidence_threshold" {
  description = "Composite-confidence floor the AgentCore Policy enforces before the agent may invoke set_draw_status through the gateway. Templated into the Cedar policy; the Config-tab UI updates it via the Policy update API. Default 0.85 (not 0.95): 0.95 is unreachable on either backend because the model's verbalized term caps the weighted sum around 0.89-0.91 — see the foundation module's auto-resolve-threshold comment and the harness signal + tool-parity design record (D5/D6). Keep the two in step."
  type        = number
  default     = 0.85
}

variable "policy_enforcement_mode" {
  description = "AgentCore Policy mode on the egress gateway: LOG_ONLY (evaluate + log, don't block) or ENFORCE (block below-threshold writes). Defaults to ENFORCE: the Cedar confidence gate is the SOLE threshold enforcement for autonomous writes (the write Lambda no longer re-checks the threshold). Set LOG_ONLY only to temporarily observe decisions without blocking."
  type        = string
  default     = "ENFORCE"
  validation {
    condition     = contains(["LOG_ONLY", "ENFORCE"], var.policy_enforcement_mode)
    error_message = "policy_enforcement_mode must be LOG_ONLY or ENFORCE."
  }
}

variable "otel_baggage_span_attribute_keys" {
  description = "OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS for the runtime container: W3C baggage keys the ADOT distro promotes onto this runtime's spans. The agent-worker Lambda sends the baggage (recon.item_id / recon.domain / recon.backend / session.id) on every invocation; without this allow-list the header still propagates but nothing is recorded, so agent spans cannot be filtered by the business key. Keep identical to the tier1 + harness modules' value."
  type        = string
  default     = ""
}
