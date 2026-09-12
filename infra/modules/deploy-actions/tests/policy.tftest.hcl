# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only under MOCKED aws and archive providers: nothing is created, no credentials are read, and
# the handler zip is not built (the archive data source is overridden). The two aws data sources are
# overridden so the region and account in the rendered ARNs are known at plan.
#
# Under test is the actor role's policy, and one property of it above all: with no additional seed
# bucket -- every recon-only deployment -- it renders BYTE FOR BYTE the six statements it rendered
# before additional_assets_bucket_arns existed, so the deployed aws_iam_role_policy plans no change.
# Then that each additional bucket appends exactly the two seed-reconciliation statements, after
# those six, and nothing else moves.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }
  override_data {
    target = data.aws_region.current
    values = {
      region = "us-east-1"
    }
  }
}

mock_provider "archive" {
  override_data {
    target = data.archive_file.handler
    values = {
      output_path         = ".build/deploy-actions.zip"
      output_base64sha256 = "dGVzdA=="
    }
  }
}

variables {
  name_prefix       = "deploy-test"
  assets_bucket_arn = "arn:aws:s3:::deploy-test-assets"
  user_pool_arn     = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_deploytest"

  # GOLDEN. The statement list main.tf rendered for exactly the inputs above BEFORE the additional
  # buckets existed, spelled out as the same HCL so jsonencode() of it is the same string: same six
  # statements, same order, same key set in each. A change to any of them is a change to what every
  # deployed environment's actor may do, so make it on purpose and then update this list.
  golden_statements = [
    {
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/deploy-test-deploy-actions:*"
    },
    {
      Effect = "Allow"
      Action = [
        "bedrock:GetDataSource",
        "bedrock:StartIngestionJob",
        "bedrock:GetIngestionJob",
      ]
      Resource = "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/*"
    },
    {
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:GetGatewayTarget"]
      Resource = "*"
    },
    {
      Effect   = "Allow"
      Action   = ["s3:GetEncryptionConfiguration"]
      Resource = "arn:aws:s3:::deploy-test-assets"
    },
    {
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "arn:aws:s3:::deploy-test-assets/*"
    },
    {
      Effect   = "Allow"
      Action   = ["cognito-idp:UpdateUserPoolClient"]
      Resource = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_deploytest"
    },
  ]
}

run "with_no_additional_bucket_the_policy_is_byte_for_byte_what_it_always_was" {
  command = plan

  assert {
    condition = aws_iam_role_policy.actions.policy == jsonencode({
      Version   = "2012-10-17"
      Statement = var.golden_statements
    })
    error_message = "with additional_assets_bucket_arns = [] the actor policy must render exactly the six statements it rendered before that input existed; a deployed recon environment would otherwise plan an update of aws_iam_role_policy.actions"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.actions.policy).Statement) == 6
    error_message = "six statements, no more: nothing may be appended when there is no additional bucket"
  }
}

run "each_additional_bucket_appends_its_two_seed_statements_after_the_six" {
  command = plan

  variables {
    additional_assets_bucket_arns = ["arn:aws:s3:::deploy-test-pipeline-assets"]
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.actions.policy).Statement) == 8
    error_message = "one additional bucket must add exactly two statements"
  }

  # The first six are untouched, in place: the additions come after, never interleaved.
  assert {
    condition     = jsonencode(slice(jsondecode(aws_iam_role_policy.actions.policy).Statement, 0, 6)) == jsonencode(var.golden_statements)
    error_message = "the six original statements must be first and unchanged when a bucket is added"
  }

  # The same two grants the recon bucket gets, on the additional bucket: encryption read on the
  # bucket (the ETag-is-an-MD5 check), object read/write under it.
  assert {
    condition = jsonencode(slice(jsondecode(aws_iam_role_policy.actions.policy).Statement, 6, 8)) == jsonencode([
      {
        Effect   = "Allow"
        Action   = ["s3:GetEncryptionConfiguration"]
        Resource = "arn:aws:s3:::deploy-test-pipeline-assets"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::deploy-test-pipeline-assets/*"
      },
    ])
    error_message = "the appended statements must be GetEncryptionConfiguration on the bucket and GetObject/PutObject under it, in that order"
  }
}
