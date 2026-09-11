variable "name_prefix" {
  description = "Resource name prefix, e.g. recon-dev."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared Lambda deployment package."
  type        = string
}

variable "lambda_source_hash" {
  description = "Source hash of the shared Lambda package, so a code change redeploys."
  type        = string
}

variable "max_concurrent_investigations" {
  description = <<-EOT
    MaxConcurrency for the Distributed Map: the ceiling on simultaneous Tier-2 investigations, and the
    Bedrock TPM budget under async dispatch.

    This is where the bound lives for the RUNTIME backend. It cannot live on the dispatcher's Lambda
    concurrency any more: the dispatcher returns in ~1s, so N slots would admit hundreds of concurrent
    investigations. A child paused on waitForTaskToken is still a RUNNING child execution, which is
    what makes MaxConcurrency the right instrument -- it counts investigations in flight, not calls
    being made.

    The harness backend still runs inside the blocking agent-worker, so it is bounded by that
    function's reserved_concurrent_executions instead. Keep the two values in step: they are the same
    quota expressed against two different mechanisms.

    Derivation and both bounds: see the tier1 module's variable of the same name.
  EOT
  type        = number
  default     = 14
}

variable "agent_runtime_arn" {
  description = "AgentCore runtime ARN the dispatcher invokes."
  type        = string
}

variable "agent_worker_function_arn" {
  description = <<-EOT
    The blocking agent-worker. Still used, deliberately: the harness backend runs in-process there and
    has no container of its own to background into, so the map's harness branch calls it synchronously.
  EOT
  type        = string
}

variable "cases_table" {
  description = "Name of the recon-cases table."
  type        = string
}

variable "cases_table_arn" {
  description = "ARN of the recon-cases table, for the GSI query and the FAILED write."
  type        = string
}

variable "audit_table" {
  description = "Name of the recon-audit table."
  type        = string
}

variable "audit_table_arn" {
  description = "ARN of the recon-audit table, for the audit row on a FAILED transition."
  type        = string
}

variable "runs_bucket" {
  description = "Bucket holding each run's collected PENDING-case list (the Map's ItemReader input)."
  type        = string
}

variable "runs_bucket_arn" {
  description = "ARN of the runs bucket."
  type        = string
}

variable "runs_prefix" {
  description = "Key prefix for run input objects."
  type        = string
  default     = "tier2-runs/"
}

variable "max_items_per_run" {
  description = <<-EOT
    Hard ceiling on how many PENDING cases one run collects. MaxConcurrency bounds the RATE of
    investigations but not the TOTAL, so without this a runaway backlog is still attempted in full.
    Anything over the ceiling stays PENDING and is picked up by the next run.
  EOT
  type        = number
  default     = 5000
}

variable "agent_backend_param" {
  description = "SSM parameter naming the active backend, read ONCE per run by the collect step."
  type        = string
  default     = ""
}

variable "use_ingress_gateway" {
  description = "Dispatch through the AgentCore ingress gateway, with a direct-invoke fallback."
  type        = bool
  default     = false
}

variable "ingress_gateway_url" {
  description = "Ingress gateway base URL. Empty disables the ingress path."
  type        = string
  default     = ""
}

variable "ingress_gateway_arn" {
  description = "Ingress gateway ARN, for the InvokeGateway grant."
  type        = string
  default     = ""
}

variable "ingress_target_name" {
  description = "Gateway target fronting the runtime."
  type        = string
  default     = "recon-agent"
}

variable "state_timeout_seconds" {
  description = <<-EOT
    How long a child waits for the agent to signal its task token before failing with States.Timeout.

    1800s is ~3x the worst investigation observed in 30 days (605s). No HeartbeatSeconds is set on
    purpose: heartbeats need a background ticker inside the container, which buys faster dead-agent
    detection at the cost of a second failure mode. One authority on when to give up is worth more here.

    Must stay well under the 8-hour AgentCore session lifetime so this timeout, not the platform, is
    what decides a run is dead.
  EOT
  type        = number
  default     = 1800
}

variable "schedule_expression" {
  description = <<-EOT
    EventBridge schedule for the map run, e.g. "cron(0 12 * * ? *)". The rule ships DISABLED (see
    schedule_enabled) so merging this does not start firing runs in an environment nobody is watching.
  EOT
  type        = string
  default     = "cron(0 12 * * ? *)"
}

variable "schedule_enabled" {
  description = "Whether the scheduled map run is enabled. Defaults to false -- opt in per environment."
  type        = bool
  default     = false
}

variable "vpc_subnet_ids" {
  description = "Subnets for VPC-attached Lambdas. Empty means no VPC config."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security groups for VPC-attached Lambdas."
  type        = list(string)
  default     = []
}
