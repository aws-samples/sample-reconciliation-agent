####################################################################################
# deploy-actions: one Lambda that performs the apply-time steps Terraform cannot express.
#
# Its actions are readiness waits on asynchronous service validation, and one-shot API calls that
# have no matching Terraform resource. Callers reach it with `aws_lambda_invocation`, which runs
# synchronously at apply time in dependency order and fails the apply when the action fails — the
# same contract a `local-exec` provisioner would give, except the work happens in the account rather
# than on whatever machine runs Terraform, so no local AWS CLI or botocore version matters.
#
# ⚠️ THIS FUNCTION IS DELIBERATELY NOT BUILT BY infra/modules/lambda-package.
#
# That module runs `pip --platform` into a staging directory that `data.archive_file` reads at PLAN
# time, which is the largest remaining reason a plan needs local tooling. The handler here imports
# only the stdlib and the boto3 the Lambda runtime already ships, so `archive_file` zips src/
# directly with nothing to install. Do not add a third-party import, and do not route this through
# lambda-package: either one reintroduces the coupling this function exists to remove.
####################################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  region        = data.aws_region.current.region
  function_name = "${var.name_prefix}-deploy-actions"
}

data "archive_file" "handler" {
  type        = "zip"
  source_dir  = "${path.module}/src"
  output_path = "${path.module}/.build/deploy-actions.zip"
  # __pycache__ would make the zip hash depend on whether anyone happened to import the module
  # locally, producing a spurious source_code_hash change.
  excludes = ["__pycache__", "**/__pycache__"]
}

resource "aws_iam_role" "actions" {
  name = local.function_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "actions" {
  #checkov:skip=CKV_AWS_290:The bedrock-agent and bedrock-agentcore-control read/start actions below do not support resource-level scoping in this API. Every grant that MUTATES anything is resource-scoped: the S3 seed writes to the assets bucket, StartIngestionJob to a knowledge-base ARN pattern (the cycle it avoids is explained below).
  name = "${local.function_name}-policy"
  role = aws_iam_role.actions.id
  policy = jsonencode({
    Version = "2012-10-17"
    # concat(): the five statements every deployment has, in the order they have always rendered,
    # then two per additional seed bucket, then the Cognito callback patch's one when a pool ARN was
    # passed. With no additional bucket and no pool the JSON is unchanged, byte for byte, from before
    # either input existed — tests/policy.tftest.hcl pins that.
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.function_name}:*"
      },
      {
        # KB readiness + ingestion.
        #
        # ⚠️ Scoped to an account/region ARN PATTERN rather than the knowledge base's own ARN, and
        # that is a deliberate trade, not laziness. module.recon_agent consumes this function's name
        # (its data-source and gateway-target waits live inside that module), so referencing
        # module.recon_agent's knowledge-base ARN here would make the two modules depend on each
        # other and Terraform would refuse the graph outright.
        #
        # The alternative — declaring the grant in the environment root against the role this module
        # exports — moves the cycle rather than removing it, because the waits still have to be
        # ordered after the policy. So the grant is account-scoped, and narrow in the actions it
        # allows: two reads and StartIngestionJob, which cannot affect anything outside a knowledge
        # base's own index.
        Effect = "Allow"
        Action = [
          "bedrock:GetDataSource",
          "bedrock:StartIngestionJob",
          "bedrock:GetIngestionJob",
        ]
        Resource = "arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/*"
      },
      {
        # Gateway target readiness. Read-only.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetGatewayTarget"]
        Resource = "*"
      },
      {
        # Seed reconciliation: read the bucket's default encryption (the ETag-is-an-MD5 invariant the
        # whole comparison rests on), read seed objects and markers, and write both.
        Effect = "Allow"
        # ⚠️ NOT "s3:GetBucketEncryption". The API call is GetBucketEncryption but the IAM action
        # that authorizes it is s3:GetEncryptionConfiguration — one of S3's several action names that
        # do not match their API. Granting the API name is silently ineffective: a valid-looking
        # policy that authorizes nothing, and every call fails with AccessDenied.
        Action   = ["s3:GetEncryptionConfiguration"]
        Resource = var.assets_bucket_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${var.assets_bucket_arn}/*"
      },
      ], flatten([
        # Seed reconciliation for each additional bucket (the deal pipeline's): the same two
        # statements as above, same action-name caveat.
        for arn in var.additional_assets_bucket_arns : [
          {
            Effect   = "Allow"
            Action   = ["s3:GetEncryptionConfiguration"]
            Resource = arn
          },
          {
            Effect   = "Allow"
            Action   = ["s3:GetObject", "s3:PutObject"]
            Resource = "${arn}/*"
          },
        ]
      ]),
      # The Cognito callback patch (`patch_cognito_callbacks`), scoped to the ONE pool the console
      # signs in against and appended LAST, so an Okta or Entra deployment -- user_pool_arn = "" --
      # renders no Cognito grant of any kind.
      #
      # Describe AND Update, because UpdateUserPoolClient REPLACES the client's configuration instead
      # of merging into it: the action reads the live client, changes only callback_urls and
      # logout_urls, and writes the rest back as found. Granting Update alone would force the client's
      # whole configuration into the invocation's input, where it would drift from the console-auth
      # module that actually declares it.
      var.user_pool_arn == "" ? [] : [
        {
          Effect   = "Allow"
          Action   = ["cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient"]
          Resource = var.user_pool_arn
        },
    ])
  })
}

resource "aws_cloudwatch_log_group" "actions" {
  #checkov:skip=CKV_AWS_158:Logs use the default CloudWatch-managed key; a customer-managed CMK adds overhead not warranted for deploy-time logs.
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "actions" {
  #checkov:skip=CKV_AWS_115:Reserved concurrency is inappropriate for a function invoked only by an apply; a reservation would take concurrency from the request-serving functions for no benefit.
  #checkov:skip=CKV_AWS_117:Deliberately NOT VPC-attached — every API it calls is a public AWS control plane, and attaching it would add ENI create/teardown to the critical path of an apply (the same teardown lag that makes AgentCore destroys slow).
  #checkov:skip=CKV_AWS_116:A DLQ is meaningless here: invocations are synchronous, and a failure must surface as a failed apply rather than being queued for later.
  #checkov:skip=CKV_AWS_272:Code signing is not configured for any Lambda in this project.
  function_name = local.function_name
  role          = aws_iam_role.actions.arn
  runtime       = "python3.12"
  handler       = "handler.handle"

  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256

  # The longest action is a 10-minute poll (KB ingestion, and the two readiness waits). 15 minutes
  # is Lambda's ceiling and leaves headroom without letting a wedged poll run indefinitely — the
  # action's own attempt budget is what is meant to expire first, because it fails with a useful
  # message where a Lambda timeout says only "task timed out".
  timeout = 900

  # 512 MB rather than the 128 MB default: these are boto3 API-poll workloads, and the default
  # starves the interpreter's startup enough to add seconds to every apply for no saving.
  memory_size = 512

  depends_on = [aws_cloudwatch_log_group.actions]
}
