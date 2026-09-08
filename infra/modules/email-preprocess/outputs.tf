output "function_name" {
  description = "Name of the pre-processor. The console passes this as EMAIL_PREPROCESS_FUNCTION."
  value       = aws_lambda_function.preprocess.function_name
}

output "function_arn" {
  description = "ARN of the pre-processor, for the console task role's scoped lambda:InvokeFunction grant."
  value       = aws_lambda_function.preprocess.arn
}
