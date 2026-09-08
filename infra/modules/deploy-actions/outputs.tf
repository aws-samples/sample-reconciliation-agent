output "function_name" {
  description = "Name of the deploy-actions Lambda, for aws_lambda_invocation.function_name."
  value       = aws_lambda_function.actions.function_name
}

output "function_arn" {
  description = "ARN of the deploy-actions Lambda."
  value       = aws_lambda_function.actions.arn
}

output "source_code_hash" {
  description = <<-EOT
    Base64 SHA-256 of the handler zip. Callers fold this into their aws_lambda_invocation input so a
    handler change re-runs the actions — an invocation keyed only on its own arguments would keep
    returning the previous result after the code that produced it changed.
  EOT
  value       = aws_lambda_function.actions.source_code_hash
}
