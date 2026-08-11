variable "lambda_function_names" {
  description = "Lambda function names to provision CloudWatch log groups for."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 365
}
