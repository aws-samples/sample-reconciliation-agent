output "notices_table_name" {
  description = "Name of the recon-notices table (the actual side)."
  value       = aws_dynamodb_table.notices.name
}

output "notices_table_arn" {
  description = "ARN of the recon-notices table, for IAM grants."
  value       = aws_dynamodb_table.notices.arn
}

output "notice_tool_lambda_arn" {
  description = "ARN of the search_notices query Lambda, for the gateway target."
  value       = aws_lambda_function.notice_query.arn
}

output "notice_tool_lambda_name" {
  description = "Name of the search_notices query Lambda, for the gateway invoke permission."
  value       = aws_lambda_function.notice_query.function_name
}
