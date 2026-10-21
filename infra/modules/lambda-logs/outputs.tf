output "log_group_names" {
  description = "Names of the created CloudWatch log groups."
  value       = [for lg in aws_cloudwatch_log_group.lambda : lg.name]
}

output "log_group_arns" {
  description = "ARN of each log group, keyed as its instance is: by function name for lambda_function_names entries, by label for lambda_functions_by_key entries."
  value       = { for key, lg in aws_cloudwatch_log_group.lambda : key => lg.arn }
}
