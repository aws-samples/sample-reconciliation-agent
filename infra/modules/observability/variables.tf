variable "resource_name" {
  description = "Identifier for the AgentCore resource (e.g., 'gateway', 'memory')"
  type        = string
}

variable "resource_arn" {
  description = "ARN of the AgentCore resource to enable observability for"
  type        = string
}

variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 365
}

variable "enable_xray_traces" {
  description = <<-EOT
    Enable X-Ray trace delivery for the agent runtime. Requires the account-level X-Ray
    trace-segment destination to be set to CloudWatch Logs (a one-time account prerequisite
    AWS manages via the reserved aws/spans log group). Application-log delivery is always on;
    only trace delivery is gated so a fresh account applies cleanly in one pass.
  EOT
  type        = bool
  default     = false
}
