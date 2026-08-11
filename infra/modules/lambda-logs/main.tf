####################################################################################
# Lambda log groups for the platform's Lambdas (intake, Tier-1, agent-worker, BFFs).
# The AgentCore runtime's OTEL logs/traces are handled by the observability module.
####################################################################################

resource "aws_cloudwatch_log_group" "lambda" {
  #checkov:skip=CKV_AWS_158:Logs use the default CloudWatch-managed key; a customer-managed CMK adds overhead not warranted for demo logs.
  for_each          = toset(var.lambda_function_names)
  name              = "/aws/lambda/${each.value}"
  retention_in_days = var.log_retention_days
}
