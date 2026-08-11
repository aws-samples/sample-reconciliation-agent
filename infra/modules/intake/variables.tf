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

variable "user_pool_endpoint" {
  description = "Cognito user pool endpoint (JWT issuer base, without scheme)."
  type        = string
}

variable "spa_client_id" {
  description = "Cognito SPA app client id (JWT audience)."
  type        = string
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
