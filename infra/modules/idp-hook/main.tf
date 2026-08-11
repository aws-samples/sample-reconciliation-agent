####################################################################################
# IDP post-processing hook Lambda. IDP invokes this (via its PostProcessingLambdaHookFunctionArn
# — set separately, out of scope here) on document completion; it writes a ReconItem through the
# normal intake path. Only channel to IDP is this inbound invocation. ARN is a module output.
####################################################################################

# The Lambda deployment zip is built once by the shared lambda-package module (root contains
# the backend/ package); passed in via var.lambda_zip / var.lambda_source_hash.

# Used to scope IAM statements and the EventBridge invoke permission to this account/region.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}

resource "aws_iam_role" "hook" {
  name = "${var.name_prefix}-idp-hook"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "hook" {
  name = "${var.name_prefix}-idp-hook-policy"
  role = aws_iam_role.hook.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # VPC-attached Lambda ENI create/delete — scope to this account/region.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${local.region}:${local.account_id}:*"
      },
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (must be "*").
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },

      {
        # Items table: PutItem for first ingest; GetItem to compare the incoming IDP run id
        # against the stored one (reprocess detection).
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem"]
        Resource = var.items_table_arn
      },
      {
        # Cases + audit: a genuine IDP reprocess re-drives the case (read status, reset to
        # PENDING / age out, append audit rows).
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = [var.cases_table_arn, var.audit_table_arn]
      },
      {
        # Re-dispatch the Tier-2 agent worker on a reprocess re-drive (async Event invoke).
        # Guarded so the statement is valid even when no worker arn is wired.
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = var.agent_worker_function_arn != "" ? var.agent_worker_function_arn : "arn:aws:lambda:${local.region}:${local.account_id}:function:${var.name_prefix}-agent-worker"
      },
      {
        # READ-ONLY read of IDP's output bucket at ingest, to embed extracted field values +
        # page-image locations into the ReconItem. This is the one sanctioned IDP-storage read
        # (user-approved); the recon runtime/agent never reads IDP S3.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${var.idp_output_bucket}",
          "arn:aws:s3:::${var.idp_output_bucket}/*",
        ]
      },
      {
        # Copy page previews into recon's own assets bucket at ingest (UI serves same-origin).
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${var.assets_bucket_arn}/idp-pages/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "hook" {
  function_name    = "${var.name_prefix}-idp-hook"
  role             = aws_iam_role.hook.arn
  runtime          = "python3.12"
  handler          = "backend.idp_hook.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout     = 60
  memory_size = 512

  environment {
    variables = {
      ITEMS_TABLE   = var.items_table
      RECON_DOMAIN  = var.recon_domain
      ASSETS_BUCKET = var.assets_bucket
      # Reprocess re-drive: re-open the case + re-dispatch the agent on a NEW IDP run.
      CASES_TABLE           = var.cases_table
      AUDIT_TABLE           = var.audit_table
      AGENT_WORKER_FUNCTION = var.agent_worker_function_arn
      AGENT_RUNTIME_ARN     = var.agent_runtime_arn
      REPROCESS_CAP         = tostring(var.reprocess_cap)
    }
  }
}

# Allow IDP's EventBridge completion rule to invoke this hook. The rule's exact name is created
# out-of-band by the IDP stack, so scope to any EventBridge rule in this account/region (source_arn)
# plus source_account — closing the confused-deputy hole without needing the specific rule ARN.
resource "aws_lambda_permission" "eventbridge" {
  statement_id   = "AllowIDPEventBridgeInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.hook.function_name
  principal      = "events.amazonaws.com"
  source_account = local.account_id
  source_arn     = "arn:aws:events:${local.region}:${local.account_id}:rule/*"
}
