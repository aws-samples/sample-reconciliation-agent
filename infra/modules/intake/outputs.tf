output "api_id" {
  description = "HTTP API id (shared with the BFF module for additional routes)."
  value       = aws_apigatewayv2_api.http.id
}

output "api_endpoint" {
  description = "Base invoke URL of the HTTP API."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "authorizer_id" {
  description = "OIDC JWT authorizer id (reused by the BFF routes)."
  value       = aws_apigatewayv2_authorizer.jwt.id
}

output "execution_arn" {
  description = "API execution ARN (for Lambda invoke permissions)."
  value       = aws_apigatewayv2_api.http.execution_arn
}

output "private_api_id" {
  description = "Private intake REST API id, or \"\" when private_api_enabled = false."
  value       = var.private_api_enabled ? aws_api_gateway_rest_api.private[0].id : ""
}

output "private_api_invoke_url" {
  description = <<-EOT
    Base invoke URL of the private intake REST API ("" when disabled). This is the VPC-endpoint
    hostname form, not <api-id>.execute-api.<region>.amazonaws.com: the execute-api endpoint runs with
    private DNS DISABLED on purpose (enabling it would hijack the wildcard for the whole VPC and break
    in-VPC calls to every public API Gateway API), and this hostname resolves without it.
  EOT
  value = var.private_api_enabled ? format(
    "https://%s-%s.execute-api.%s.vpce.amazonaws.com/%s",
    aws_api_gateway_rest_api.private[0].id,
    var.execute_api_vpc_endpoint_id,
    data.aws_region.current.region,
    aws_api_gateway_stage.v1[0].stage_name,
  ) : ""
}

output "function_name" {
  description = "Intake Lambda name (the frontend BFF invokes it for manual submissions)."
  value       = aws_lambda_function.intake.function_name
}

output "function_arn" {
  description = "Intake Lambda ARN (for a scoped lambda:InvokeFunction grant)."
  value       = aws_lambda_function.intake.arn
}
