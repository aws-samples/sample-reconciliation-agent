variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "enabled" {
  description = "When false, the module is a no-op. Driven by presence of client_id/secret/tenant_id."
  type        = bool
}

variable "gateway_id" {
  description = "AgentCore Gateway ID to attach the microsoft-graph target to."
  type        = string
}

variable "tenant_id" {
  description = "Microsoft Entra tenant GUID. OBO discovery URL embeds this — `common` will not resolve."
  type        = string
}

variable "client_id" {
  description = "Microsoft Entra app (client) ID. The Gateway audience is api://<client_id>."
  type        = string
  sensitive   = true
}

variable "client_secret" {
  description = "Microsoft Entra app client secret used to authenticate the OBO token exchange."
  type        = string
  sensitive   = true
}

variable "auth_mode" {
  description = <<-EOT
    "obo" (default) — On-Behalf-Of token exchange. Requires the inbound token's issuer to be
    Entra itself (delegated user identity flows through to Graph). NOT compatible with a
    Cognito-issued inbound token, since Entra cannot exchange a token it didn't issue.

    "client_credentials" — App-only (service-account / 2LO) auth. The gateway acquires its own
    Graph token via client_credentials against Entra, independent of the inbound token's
    issuer. This is what a gateway whose inbound auth is not Entra must use — including recon's,
    whose gateways are AWS_IAM. Only app-only
    compatible Graph operations are exposed (see openapi-schema-app.json) — delegated-only
    endpoints like /me are not callable without a signed-in user.
  EOT
  type        = string
  default     = "obo"

  validation {
    condition     = contains(["obo", "client_credentials"], var.auth_mode)
    error_message = "auth_mode must be \"obo\" or \"client_credentials\"."
  }
}
