variable "lambda_function_names" {
  description = "Lambda function names to provision CloudWatch log groups for. Each group's state address is keyed by the function NAME: aws_cloudwatch_log_group.lambda[\"<name>\"]."
  type        = list(string)
  default     = []
}

variable "lambda_functions_by_key" {
  description = <<-EOT
    Lambda function names keyed by a caller-chosen label, e.g. { parser = "<prefix>-parser" }. The
    same log groups as lambda_function_names, but each group's state address is keyed by the LABEL
    (aws_cloudwatch_log_group.lambda["parser"]) rather than by the function name. That is what a
    caller with a `moved` block needs: the index key in a moved address must be a literal, and a
    function name built from a prefix variable is not one.
  EOT
  type        = map(string)
  default     = {}

  validation {
    # A label equal to a name in lambda_function_names would be one address for two functions.
    condition     = length(setintersection(toset(keys(var.lambda_functions_by_key)), toset(var.lambda_function_names))) == 0
    error_message = "lambda_functions_by_key labels must not repeat a name in lambda_function_names: both key the same resource, so the two would share one state address."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 365
}
