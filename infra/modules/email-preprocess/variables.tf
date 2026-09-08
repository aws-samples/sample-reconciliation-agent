variable "name_prefix" {
  description = "Prefix for every resource name in this module."
  type        = string
}

variable "assets_bucket" {
  description = "Recon's own assets bucket. Staged uploads are read from it and derived parts written back to it; the function never touches a destination bucket."
  type        = string
}

variable "assets_bucket_arn" {
  description = "ARN of the same bucket, for the two prefix-scoped statements."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared backend deployment package."
  type        = string
}

variable "lambda_source_hash" {
  description = "base64 sha256 of the same package, so a code change redeploys the function."
  type        = string
}

variable "vpc_subnet_ids" {
  description = "Private subnets. Empty runs the function outside the VPC."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security groups for the function's ENIs."
  type        = list(string)
  default     = []
}
