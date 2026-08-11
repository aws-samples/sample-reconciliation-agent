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
