output "hook_function_arn" {
  description = "ARN to set as IDP's PostProcessingLambdaHookFunctionArn (IDP-side, out of scope here)."
  value       = aws_lambda_function.hook.arn
}
