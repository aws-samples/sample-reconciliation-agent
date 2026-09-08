variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
}

variable "harness_config_dir" {
  description = <<-EOT
    Path to the blueprint dir holding harness_config.py and its derived harness_config.json.
    Terraform reads the JSON (tools, allowedTools, maxIterations, lifecycle timeouts); the .py
    remains the authored source of truth. Regenerate with
    `python3 infra/scripts/gen_harness_config_json.py`.
  EOT
  type        = string
}

variable "gateway_arn" {
  description = "Egress tools gateway ARN — the harness calls it with awsIam outbound auth."
  type        = string
}

variable "harness_model_id" {
  description = "Bedrock model id / inference profile for the harness."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "assets_bucket" {
  description = "Assets bucket holding the harness system prompt + skills."
  type        = string
}

variable "assets_bucket_arn" {
  description = "Assets bucket ARN (for S3 read IAM)."
  type        = string
}

variable "skills_prefix" {
  description = "S3 prefix under which skills/<name>/SKILL.md live."
  type        = string
  default     = "skills/"
}

variable "skill_names" {
  description = "Skill directory names to bind as harness skills (skills/<name>/)."
  type        = list(string)
  default     = []
}

variable "system_prompt" {
  description = "The harness system prompt text (workflow contract)."
  type        = string
}

variable "vpc_subnet_ids" {
  description = "Private subnets for the harness microVM ([] = PUBLIC)."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}

# ---------------------------------------------------------------------------------
# Harness OTel configuration (environmentVariables on the harness definition).
# Recommended by aws-samples/sample-ac-harness-observability; see
# the note in modules/tier1/main.tf for why two of the sample's
# settings default to OFF here.
# ---------------------------------------------------------------------------------

variable "otel_excluded_urls" {
  description = "Span-noise reduction: URLs the harness must not trace (health checks, IMDS)."
  type        = string
  default     = "169.254.169.254,/ping,/health"
}

variable "otel_disabled_instrumentations" {
  description = <<-EOT
    Span-noise reduction: auto-instrumentations to disable inside the harness. Empty disables none.
    NOTE: this includes `botocore`, so if gen-ai event records stop reaching the harness log group
    (the online evaluators' data source), drop `botocore` from this list and re-apply.
  EOT
  type        = string
  default     = "urllib3,requests,botocore,aiohttp-client,httpx"
}

variable "otel_baggage_span_attribute_keys" {
  description = <<-EOT
    Allow-list of W3C baggage keys AgentCore promotes to span attributes on the harness's spans.
    Baggage keys NOT listed here travel on the wire but never become attributes, so this must stay
    in sync with the keys backend/recon_core/otel_client.py sets and with the worker Lambda's copy
    of this variable.
  EOT
  type        = string
  default     = "harness.id,harness.endpoint.qualifier,session.id,recon.item_id,recon.domain,recon.backend"
}

variable "otel_genai_content_extraction_opt_out" {
  description = <<-EOT
    Stop the harness from emitting gen-ai prompt/completion CONTENT to observability.
    Defaults to false (content IS emitted) because the online evaluators score gen-ai content
    records read from the harness log group — opting out starves them. Set true only for a harness
    with no evaluators attached.
  EOT
  type        = bool
  default     = false
}

variable "otel_semconv_stability_opt_in" {
  description = <<-EOT
    OTEL_SEMCONV_STABILITY_OPT_IN for the harness (e.g.
    "gen_ai_latest_experimental,gen_ai_span_attributes_only"). Empty = unset.
    `gen_ai_span_attributes_only` suppresses content the online evaluators need, hence the empty
    default — see otel_genai_content_extraction_opt_out.
  EOT
  type        = string
  default     = ""
}

variable "otel_exporter_otlp_endpoint" {
  description = "Optional third-party OTLP endpoint for the harness. Empty = CloudWatch only."
  type        = string
  default     = ""
}

variable "otel_exporter_otlp_headers" {
  description = "Auth headers for otel_exporter_otlp_endpoint (e.g. \"api-key=...\"). Empty = unset."
  type        = string
  default     = ""
  sensitive   = true
}
