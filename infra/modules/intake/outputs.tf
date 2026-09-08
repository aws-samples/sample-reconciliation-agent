output "api_id" {
  description = "HTTP API id (shared with the BFF module for additional routes)."
  value       = aws_apigatewayv2_api.http.id
}

output "api_endpoint" {
  description = "Base invoke URL of the HTTP API."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "authorizer_id" {
  description = "Cognito JWT authorizer id (reused by the BFF routes)."
  value       = aws_apigatewayv2_authorizer.jwt.id
}

output "execution_arn" {
  description = "API execution ARN (for Lambda invoke permissions)."
  value       = aws_apigatewayv2_api.http.execution_arn
}

output "function_name" {
  description = "Intake Lambda name (the frontend BFF invokes it for manual submissions)."
  value       = aws_lambda_function.intake.function_name
}

output "function_arn" {
  description = "Intake Lambda ARN (for a scoped lambda:InvokeFunction grant)."
  value       = aws_lambda_function.intake.arn
}
