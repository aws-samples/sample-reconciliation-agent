variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
}

variable "items_table" {
  description = "Name of the recon-items DynamoDB table."
  type        = string
}

variable "items_table_arn" {
  description = "ARN of the recon-items DynamoDB table (for least-privilege IAM)."
  type        = string
}

variable "jwt_issuer" {
  description = "OIDC issuer the HTTP API's JWT authorizer validates (`iss`), including scheme. Derived from auth_provider in the root module."
  type        = string

  # No default and no fallback: an empty issuer would create an authorizer that rejects every token,
  # and the failure looks like a broken deployment rather than missing configuration.
  validation {
    condition     = startswith(var.jwt_issuer, "https://")
    error_message = "jwt_issuer must be the provider's issuer URL including https:// (Okta: okta_issuer; Entra: https://login.microsoftonline.com/<tenant>/v2.0)."
  }
}

variable "jwt_audience" {
  description = "Expected `aud` claim — the OIDC client id of the app whose tokens may call the API."
  type        = string

  validation {
    condition     = var.jwt_audience != ""
    error_message = "jwt_audience must be the OIDC client id (okta_client_id or entra_client_id)."
  }
}

variable "lambda_zip" {
  description = "Path to the shared backend Lambda deployment zip (from the lambda-package module)."
  type        = string
}

variable "lambda_source_hash" {
  description = "Base64 SHA-256 of the shared Lambda zip (from the lambda-package module)."
  type        = string
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

variable "private_api_enabled" {
  description = <<-EOT
    Create the PRIVATE REST API door onto the intake Lambda (private_api.tf). The root wires this from
    `private_vpc`, because an HTTP API cannot be made private and the public one would otherwise be the
    only way to POST an item in an internet-restricted deployment.
  EOT
  type        = bool
  default     = false
}

variable "execute_api_vpc_endpoint_id" {
  description = "Id of the execute-api interface endpoint the private REST API is locked to."
  type        = string
  default     = ""

  # Fail the plan rather than build a private API nobody can reach: an empty id produces a resource
  # policy whose Deny matches every caller, and the symptom is a 403 with no clue where it came from.
  validation {
    condition     = !var.private_api_enabled || var.execute_api_vpc_endpoint_id != ""
    error_message = "private_api_enabled = true requires execute_api_vpc_endpoint_id (network module output execute_api_endpoint_id, which is only non-empty when enable_private_endpoints = true)."
  }
}

