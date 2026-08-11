variable "name_prefix" {
  type = string
}
variable "lambda_zip" {
  description = "Path to the shared backend Lambda deployment zip (from the lambda-package module)."
  type        = string
}
variable "lambda_source_hash" {
  description = "Base64 SHA-256 of the shared Lambda zip (from the lambda-package module)."
  type        = string
}
variable "items_table" {
  type = string
}
variable "items_table_arn" {
  type = string
}
variable "cases_table" {
  description = "Cases table name (reprocess re-drive resets/ages the case)."
  type        = string
  default     = ""
}
variable "cases_table_arn" {
  type    = string
  default = "*"
}
variable "audit_table" {
  description = "Audit table name (reprocess re-drive appends audit rows)."
  type        = string
  default     = ""
}
variable "audit_table_arn" {
  type    = string
  default = "*"
}
variable "agent_worker_function_arn" {
  description = "Agent-worker Lambda ARN; the hook re-dispatches it on an IDP reprocess re-drive. Empty disables re-dispatch (item/case still refreshed)."
  type        = string
  default     = ""
}
variable "agent_runtime_arn" {
  description = "AgentCore runtime ARN passed to the worker on a reprocess re-drive."
  type        = string
  default     = ""
}
variable "reprocess_cap" {
  description = "Max reprocess attempts before a re-drive ages the case out (parity with the UI reject->reprocess cap)."
  type        = number
  default     = 3
}
variable "recon_domain" {
  description = "Single recon domain this hook feeds (RECON_DOMAIN env)."
  type        = string
  default     = "unknown"
}

variable "idp_output_bucket" {
  description = "IDP output bucket the hook reads at ingest (may be a wildcard, e.g. 'idp-unified-output-*'), used in the read-only IAM statement."
  type        = string
  default     = "idp-unified-output-*"
}

variable "assets_bucket" {
  description = "Recon assets bucket page previews are copied into at ingest."
  type        = string
}

variable "assets_bucket_arn" {
  type = string
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
