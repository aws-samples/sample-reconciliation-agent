variable "name_prefix" {
  description = "Prefix applied to every resource name (design §3 uses \"deal-pipeline-dev\")."
  type        = string
}

variable "agent_model_id" {
  description = <<-EOT
    Bedrock model (or cross-region inference-profile) id the parsing agent invokes. This is only
    the SEED of the /<name_prefix>/agent-model-id SSM parameter: the Config tab overwrites the
    parameter at runtime and the parser reads it per invocation, so changing this after the first
    apply does nothing (the parameter carries ignore_changes on value). It is also what the
    console's assistant chat invokes directly, with no runtime override (ASSISTANT_MODEL_ID in the
    console_environment output).
  EOT
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "memory_model_id" {
  description = <<-EOT
    Bedrock model (or inference-profile) id AgentCore Memory invokes for the edge_cases strategy's
    extraction pass. Separate from agent_model_id so the memory pipeline can be pinned independently
    of the parser: extraction runs asynchronously against a fixed prompt, so it has no reason to
    follow a model switch made from the Config tab.
  EOT
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for both Lambda log groups (created through modules/lambda-logs)."
  type        = number
  default     = 14
}

variable "lambda_zip" {
  description = "Path to the backend Lambda deployment zip built by the lambda-package module (root contains the backend/ package)."
  type        = string
}

variable "lambda_source_hash" {
  description = "Base64 SHA-256 of the same zip, for aws_lambda_function.source_code_hash."
  type        = string
}

variable "content_root" {
  description = <<-EOT
    Repository root the seed files are read from: agent-blueprint/deal-pipeline-agent/{skills,prompts}
    and data/security-master live underneath it. null resolves to the checkout this module is part
    of (three levels above the module directory) -- a variable default cannot reference path.module,
    which is why the fallback lives in a local rather than here.
  EOT
  type        = string
  default     = null
}
