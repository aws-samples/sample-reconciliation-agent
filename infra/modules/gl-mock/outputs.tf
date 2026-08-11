output "function_arn" {
  description = "ARN of the gl-query Lambda (Gateway tool target + Tier-1 lookup)."
  value       = aws_lambda_function.gl_query.arn
}

output "function_name" {
  value = aws_lambda_function.gl_query.function_name
}

output "write_function_arn" {
  description = "ARN of the set-draw-status write Lambda (Gateway write tool target)."
  value       = aws_lambda_function.set_draw_status.arn
}

output "write_function_name" {
  value = aws_lambda_function.set_draw_status.function_name
}

output "status_table_name" {
  description = "DynamoDB draw/ledger status overlay table."
  value       = aws_dynamodb_table.gl_status.name
}
