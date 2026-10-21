####################################################################################
# Lambda log groups for the platform's Lambdas (intake, Tier-1, agent-worker, BFFs, and the
# deal-pipeline module's parser and mock OMS upload). The AgentCore runtime's OTEL logs/traces
# are handled by the observability module.
####################################################################################

locals {
  # Instance key => function name. A plain list keys each group by the function's own name -- the
  # recon root's groups have always been addressed that way (lambda["<prefix>-intake"], ...), so those
  # keys must not change -- and the map lets a caller choose the key instead, which is what makes the
  # address nameable in a `moved` block (see variables.tf).
  log_groups = merge(
    { for name in var.lambda_function_names : name => name },
    var.lambda_functions_by_key,
  )
}

resource "aws_cloudwatch_log_group" "lambda" {
  #checkov:skip=CKV_AWS_158:Logs use the default CloudWatch-managed key; a customer-managed CMK adds overhead not warranted for demo logs.
  for_each          = local.log_groups
  name              = "/aws/lambda/${each.value}"
  retention_in_days = var.log_retention_days
}
