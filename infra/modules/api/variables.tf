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

variable "api_id" {
  description = "HTTP API id (shared with the intake module)."
  type        = string
}

variable "authorizer_id" {
  description = "Cognito JWT authorizer id (reused from intake)."
  type        = string
}

variable "api_execution_arn" {
  description = "HTTP API execution ARN (for Lambda invoke permissions)."
  type        = string
}

variable "assets_bucket" {
  type = string
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
