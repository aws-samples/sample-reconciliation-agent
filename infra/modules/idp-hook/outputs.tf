output "hook_function_arn" {
  description = "The hook's ARN. This module creates the EventBridge rule that invokes it when idp_state_machine_arn is set; otherwise it is what an IDP-side PostProcessingLambdaHookFunctionArn must point at."
  value       = aws_lambda_function.hook.arn
}
