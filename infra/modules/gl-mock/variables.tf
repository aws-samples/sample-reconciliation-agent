variable "name_prefix" {
  type = string
}

variable "assets_bucket" {
  description = "Bucket holding the GL data (general-ledger/) and Athena results (athena-results/)."
  type        = string
}

variable "assets_bucket_arn" {
  type = string
}

variable "gl_data_dir" {
  description = "Absolute path to the directory containing gl-entries.csv."
  type        = string
}

variable "lambda_zip" {
  description = "Shared backend Lambda deployment zip (from the lambda-package module)."
  type        = string
}

variable "lambda_source_hash" {
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




