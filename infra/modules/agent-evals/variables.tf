variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared backend Lambda deployment zip."
  type        = string
}

variable "lambda_source_hash" {
  description = "Base64 SHA-256 of the shared Lambda zip."
  type        = string
}

variable "lessons_table_arn" {
  description = "ARN of the recon-lessons DynamoDB table (for the agreement evaluator)."
  type        = string
}

variable "lessons_table" {
  description = "Name of the recon-lessons table."
  type        = string
}

# The SHARED span destination. Both backends run with the unified destination enabled, so their
# spans land in the per-agent groups named by `event_log_groups` and this group normally receives
# nothing. It is listed anyway so that an agent set back to the shared destination
# (UNIFIED_TRACES_DESTINATION_ENABLED=false) keeps being evaluated without also editing this config.
# Listing a log group that receives nothing costs the evaluation config nothing.
variable "harness_log_group_name" {
  description = "Shared span log group, kept as a data source so a backend using the shared destination is still evaluated. Spans from the unified destination arrive in the per-agent groups named by `event_log_groups`."
  type        = string
  default     = "aws/spans"
}

# The evaluation service reads gen-ai EVENT RECORDS (conversation content correlated to spans
# by spanId) exclusively from the config's data-source log groups — it does NOT follow the
# spans' aws.log.group.names resource pointer. Omit a backend's runtime group here and every builtin
# judge fails with LogEventMissingException, even though the event records sit in that group.
variable "event_log_groups" {
  description = "Per-backend CloudWatch log group holding that backend's OTel gen-ai event records (/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT), keyed like service_names. Empty values are dropped."
  type        = map(string)
  default     = {}
}

# No default on purpose. A wrong service-name filter does not error — the eval config simply matches
# zero sessions and reports nothing, so any plausible-looking default would fail silently. Callers
# must pass real OTel service names: AgentCore runtimes emit service.name = "<runtimeName>.<endpoint>".
# Map, not list: the UpdateOnlineEvaluationConfig API caps serviceNames at ONE entry per
# config, so we create one config per backend — the key becomes the config-name suffix.
variable "service_names" {
  description = "OTel service names of the agent backends to evaluate, keyed by a short backend id (e.g. harness/runtime). One online eval config is created per entry."
  type        = map(string)

  validation {
    condition     = length(var.service_names) > 0
    error_message = "service_names must contain at least one backend => OTel service name entry."
  }
}

# The lock-release lever. An ACTIVE online evaluation config locks the custom evaluator it
# references against BOTH update and delete, so any change to the evaluator (its description, or a
# swap of the Lambda config) needs the configs disabled first — see the runbook on the evaluator
# resource in main.tf. Default true because ENABLED is the steady state; flipping it to false is a
# deliberate, temporary maintenance step, not a configuration a deploy should ever land on.
variable "online_evals_enabled" {
  description = "Whether the online evaluation configs run. Set false only to release the lock on the custom evaluator so it can be updated; sessions get no scores while disabled."
  type        = bool
  default     = true
}

variable "vpc_subnet_ids" {
  type    = list(string)
  default = []
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}
