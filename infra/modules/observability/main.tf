# AgentCore Observability — CloudWatch Vended Logs + X-Ray Traces

locals {
  prefix = "${var.project_name}-${var.environment}-${var.resource_name}"
}

# ============================================================
# CloudWatch Log Group (destination for APPLICATION_LOGS)
# ============================================================

resource "aws_cloudwatch_log_group" "logs" {
  #checkov:skip=CKV_AWS_158:Logs use the default CloudWatch-managed key; a customer-managed CMK adds overhead not warranted for demo logs.
  name              = "/aws/vendedlogs/bedrock-agentcore/${var.resource_name}/${var.project_name}-${var.environment}"
  retention_in_days = var.log_retention_days
}

# ============================================================
# Delivery Sources (what to collect)
# ============================================================

resource "aws_cloudwatch_log_delivery_source" "logs" {
  name         = "${local.prefix}-logs"
  log_type     = "APPLICATION_LOGS"
  resource_arn = var.resource_arn
}

# Trace delivery is gated (see enable_xray_traces) — the X-Ray trace-segment destination is a
# one-time account prerequisite AWS manages via the reserved aws/spans log group, which cannot
# be created by app Terraform. App-log delivery below is always on.
resource "aws_cloudwatch_log_delivery_source" "traces" {
  count        = var.enable_xray_traces ? 1 : 0
  name         = "${local.prefix}-traces"
  log_type     = "TRACES"
  resource_arn = var.resource_arn
}

# ============================================================
# Delivery Destinations (where to send)
# ============================================================

resource "aws_cloudwatch_log_delivery_destination" "logs" {
  name = "${local.prefix}-logs-dest"

  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.logs.arn
  }
}

resource "aws_cloudwatch_log_delivery_destination" "traces" {
  count                     = var.enable_xray_traces ? 1 : 0
  name                      = "${local.prefix}-traces-dest"
  delivery_destination_type = "XRAY"
}

# ============================================================
# Deliveries (connect source -> destination)
# ============================================================

resource "aws_cloudwatch_log_delivery" "logs" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.logs.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.logs.arn
}

resource "aws_cloudwatch_log_delivery" "traces" {
  count                    = var.enable_xray_traces ? 1 : 0
  delivery_source_name     = aws_cloudwatch_log_delivery_source.traces[0].name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.traces[0].arn
}
