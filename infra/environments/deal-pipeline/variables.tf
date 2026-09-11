variable "region" {
  description = "AWS region every resource is created in. Bedrock inference-profile ARNs in the IAM grants are scoped to it."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to every resource name (design §3)."
  type        = string
  default     = "deal-pipeline-dev"
}

variable "agent_model_id" {
  description = <<-EOT
    Bedrock model (or cross-region inference-profile) id for BOTH the parsing agent and the
    assistant. For the parser it only seeds the /<name_prefix>/agent-model-id SSM parameter,
    which the Config tab overwrites at runtime; for the assistant it is rendered into .env.local
    as ASSISTANT_MODEL_ID (design §11) and read by the BFF directly.
  EOT
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "memory_model_id" {
  description = "Bedrock model (or inference-profile) id AgentCore Memory uses for the edge_cases extraction pass. Pinned separately from agent_model_id so a Config-tab model switch cannot change how memories are extracted."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the two Lambda log groups. Short because this is demo telemetry."
  type        = number
  default     = 14
}

# Console-wide settings for the local demo (design §13; contract in
# chatbot-app/frontend/src/lib/console/types.ts). The admin group has a REAL default here, unlike the
# recon root's fail-closed blank: this root exists to run the console on a laptop, and the rendered
# .env.local should let a developer open the Settings screen and edit without first inventing a
# group name. It is environment-only by contract (rendered into .env.local, never stored), and in
# anonymous mode the anonymous subject is a console admin regardless; ANONYMOUS_GROUPS previews a
# user who is not.
variable "console_admin_group" {
  description = "OIDC group whose members may edit console-wide settings (CONSOLE_ADMIN_GROUP in .env.local). Only matters with a real identity provider; anonymous mode grants it."
  type        = string
  default     = "console-admins"
}

variable "console_organization_label" {
  description = "Label shown under the console mark in the rail (CONSOLE_ORGANIZATION_LABEL); also seeds /<name_prefix>/console/defaults/organization-label, which the Settings screen owns afterwards."
  type        = string
  default     = "Agentic Operations Console"
}
