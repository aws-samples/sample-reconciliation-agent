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

variable "harness_log_group_name" {
  description = "CloudWatch log group name where OTel spans are delivered (Transaction Search; online eval data source)."
  type        = string
  default     = "aws/spans"
}

# The evaluation service reads gen-ai EVENT RECORDS (conversation content correlated to spans
# by spanId) exclusively from the config's data-source log groups — it does NOT follow the
# spans' aws.log.group.names resource pointer. Confirmed via CloudTrail: with only aws/spans
# configured, every builtin judge failed with LogEventMissingException even though the event
# records existed in the runtime log group.
variable "event_log_groups" {
  description = "Per-backend CloudWatch log group holding that backend's OTel gen-ai event records (/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT), keyed like service_names. Empty values are dropped."
  type        = map(string)
  default     = {}
}

# No default on purpose: the eval config silently matches zero sessions when the filter is
# wrong (the old "bedrock-agentcore" default did exactly that), so callers must pass the
# real OTel service names. AgentCore runtimes emit service.name = "<runtimeName>.<endpoint>".
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

variable "vpc_subnet_ids" {
  type    = list(string)
  default = []
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}
