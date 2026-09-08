variable "name_prefix" {
  description = "Resource name prefix, e.g. recon-dev."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared backend deployment zip."
  type        = string
}

variable "lambda_source_hash" {
  description = "base64sha256 of the backend zip, so Terraform redeploys on code change."
  type        = string
}

variable "vpc_subnet_ids" {
  description = "Private subnet ids for the query Lambda. Empty list = no VPC attachment."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security group ids for the query Lambda. Empty list = no VPC attachment."
  type        = list(string)
  default     = []
}
