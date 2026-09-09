####################################################################################
# IDP post-processing hook Lambda. Invoked when an IDP document-processing execution succeeds; it
# writes a Notice to the notices table. Only channel to IDP is this inbound invocation.
#
# The trigger is the EventBridge rule at the bottom of this file, owned HERE. IDP's own
# `PostProcessingLambdaHookFunctionArn` parameter is an alternative registration path and is left
# unset — see that rule's comment for why relying on it left the hook unreachable.
#
# It CANNOT open a reconciliation case, by grant as well as by code: the role has PutItem on the
# notices table and nothing else, and the notices table has no stream.
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
        # Notices table: PutItem only. The hook writes evidence and nothing else — no items, no
        # cases, no audit, no agent dispatch. An extracted document is not a break.
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = var.notices_table_arn
      },
      {
        # READ-ONLY read of IDP's own buckets at ingest, to embed extracted field values +
        # page-image locations into the notice. This is the one sanctioned IDP-storage read
        # (user-approved); the recon runtime/agent never reads IDP S3. See var.idp_source_buckets
        # for why the working bucket is in scope alongside the output bucket.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = flatten([
          for b in var.idp_source_buckets : [
            "arn:aws:s3:::${b}",
            "arn:aws:s3:::${b}/*",
          ]
        ])
      },
      {
        # IDP encrypts its buckets with a customer-managed KMS key, so GetObject on them returns
        # `AccessDenied ... not authorized to perform: kms:Decrypt` without this — the S3 grant above
        # is necessary but not sufficient. IDP's key policy delegates to IAM (root principal with
        # kms:*), so this identity-based grant is enough and recon never has to touch IDP's key policy.
        #
        # Resource = "*" scoped by kms:ViaService rather than the key ARN, on purpose: naming the key
        # would either hard-code an id that changes when IDP is rebuilt, or need an
        # `aws_kms_alias` data source, which would make a recon plan FAIL in any environment where IDP
        # is not deployed. With this condition the role can only use KMS through S3, and its S3 reach
        # is already limited to the IDP buckets above — so the effective grant is exactly "decrypt the
        # objects it can already GetObject". Decrypt only: no Encrypt/GenerateDataKey, because the
        # preview copies land in recon's own AES256 bucket.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${local.region}.amazonaws.com" }
        }
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
      NOTICES_TABLE = var.notices_table
      ASSETS_BUCKET = var.assets_bucket
    }
  }
}

# Allow an EventBridge rule to invoke this hook. Scoped to any rule in this account/region rather
# than to the one below, because a rule created out-of-band (by an IDP deployment that does register
# a post-processing hook) must keep working — source_account still closes the confused-deputy hole.
resource "aws_lambda_permission" "eventbridge" {
  statement_id   = "AllowIDPEventBridgeInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.hook.function_name
  principal      = "events.amazonaws.com"
  source_account = local.account_id
  source_arn     = "arn:aws:events:${local.region}:${local.account_id}:rule/*"
}

####################################################################################
# The trigger. RECON owns this rule.
#
# The permission above used to be the whole story, on the assumption that "the rule's exact name is
# created out-of-band by the IDP stack". No such rule ever existed: IDP's
# `PostProcessingLambdaHookFunctionArn` was empty, its newer deployment registers no post-workflow
# hook at all, and the hook therefore never fired for a real document. A grant with nothing on the
# other end of it fails silently and forever — there is no error to notice, only an empty table.
#
# Reading the workflow's SUCCEEDED event is the SAME channel the hook was always meant to consume
# (see `data/input/IDP-EXTRACTION-REQUIREMENTS.md` §7: the completion-event hook and the IDP MCP tool
# are the only two channels). Owning the rule here adds no coupling; it removes a dependency on a
# parameter in a stack this repo does not deploy.
####################################################################################
resource "aws_cloudwatch_event_rule" "idp_complete" {
  count       = var.idp_state_machine_arn == "" ? 0 : 1
  name        = "${var.name_prefix}-idp-document-complete"
  description = "Invoke the recon IDP hook when an IDP document-processing execution succeeds."

  # Matches only SUCCEEDED, and only this state machine. The hook returns early on any other status
  # (handler.py), so the filter is belt-and-braces — but an unfiltered rule would also invoke it for
  # every other Step Functions execution in the account, which is a cost and noise problem rather
  # than a correctness one.
  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [var.idp_state_machine_arn]
      status          = ["SUCCEEDED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "idp_complete" {
  count = var.idp_state_machine_arn == "" ? 0 : 1
  rule  = aws_cloudwatch_event_rule.idp_complete[0].name
  arn   = aws_lambda_function.hook.arn

  # No `input_transformer`: the hook reads `detail.status` and `detail.output` off the raw event, and
  # a transformer here would have to be kept in step with the mapper by hand.
  #
  # A failed invocation is retried by EventBridge and then dropped. That is deliberate for now: the
  # hook is idempotent (notice_id is `idp-<ObjectKey>` and the put is an unconditional overwrite), so
  # a reprocess in IDP recovers a lost document. A DLQ here would need its own alarm and drain path
  # to be worth more than the retry.
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 3
  }
}
