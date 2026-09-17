# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only under MOCKED aws and archive providers: nothing is created, no credentials are read, and
# the handler zip is not built (the archive data source is overridden). The two aws data sources are
# overridden so the region and account in the rendered ARNs are known at plan.
#
# Under test is the actor role's policy, and one property of it above all: with no additional seed
# bucket and no user pool -- every recon-only Okta or Entra deployment -- it renders BYTE FOR BYTE the
# statements it rendered before either input existed, so the deployed aws_iam_role_policy plans no
# change. Then that each additional bucket appends exactly the two seed-reconciliation statements
# after those, that a user pool ARN appends exactly one Cognito statement LAST, and that nothing else
# moves in either case.
#
# The baseline dropped from six statements to five on 2026-09-16, when this branch merged
# origin/main: upstream removed the user pool, and with it this function's callback-patch grant
# and the input that scoped it.
#
# The grant came back on 2026-09-16, in the change that made Cognito the console's DEFAULT identity
# provider -- this time for a pool the console actually signs in to, rather than one that existed only
# to be the intake API's issuer. It is still absent unless a pool ARN is passed, so five statements
# remains the baseline: `golden_statements` below is unchanged, and the run that asserts it is the
# proof that an Okta or Entra deployment's actor policy did not move.

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

  # GOLDEN. The statement list main.tf rendered for exactly the inputs above BEFORE the additional
  # buckets existed, spelled out as the same HCL so jsonencode() of it is the same string: same five
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
  ]
}

run "with_no_additional_bucket_and_no_user_pool_the_policy_is_byte_for_byte_what_it_always_was" {
  command = plan

  assert {
    condition = aws_iam_role_policy.actions.policy == jsonencode({
      Version   = "2012-10-17"
      Statement = var.golden_statements
    })
    error_message = "with additional_assets_bucket_arns = [] and user_pool_arn = \"\" the actor policy must render exactly the five statements it rendered before either input existed; a deployed recon environment would otherwise plan an update of aws_iam_role_policy.actions"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.actions.policy).Statement) == 5
    error_message = "five statements, no more: nothing may be appended when there is no additional bucket and no user pool"
  }

  # Stated separately from the byte comparison so a failure says WHICH grant leaked: an Okta or Entra
  # deployment has no pool of ours, so the actor must hold no cognito-idp action at all.
  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_role_policy.actions.policy).Statement :
      anytrue([for a in flatten([s.Action]) : startswith(a, "cognito-idp:")])
    ])
    error_message = "with user_pool_arn = \"\" no statement may grant a cognito-idp action: an Okta or Entra deployment has no user pool for this actor to patch"
  }
}

# The Cognito grant: one statement, LAST, scoped to the one pool. Nothing before it moves, which is
# what lets a deployment switch to Cognito without re-rendering the rest of the actor's policy.
run "a_user_pool_arn_appends_one_scoped_cognito_statement_last" {
  command = plan

  variables {
    user_pool_arn = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_Example1"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.actions.policy).Statement) == 6
    error_message = "a user pool ARN must add exactly one statement, taking the actor's policy from five statements to six"
  }

  assert {
    condition     = jsonencode(slice(jsondecode(aws_iam_role_policy.actions.policy).Statement, 0, 5)) == jsonencode(var.golden_statements)
    error_message = "the five original statements must be first and unchanged when the Cognito grant is added"
  }

  # Describe AND Update: UpdateUserPoolClient replaces a client's configuration rather than merging,
  # so the action has to read the live client before writing the URLs back onto it.
  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.actions.policy).Statement[5]) == jsonencode({
      Effect   = "Allow"
      Action   = ["cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient"]
      Resource = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_Example1"
    })
    error_message = "the appended statement must grant DescribeUserPoolClient and UpdateUserPoolClient on exactly the pool ARN passed in, and nothing else; got ${jsonencode(jsondecode(aws_iam_role_policy.actions.policy).Statement[5])}"
  }

  # No wildcard anywhere in the Cognito grant's resource. An `arn:...:userpool/*` here would let the
  # actor rewrite the app client of any pool in the account, including one belonging to another stack.
  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.actions.policy).Statement : [
        for r in flatten([s.Resource]) : !strcontains(r, "*")
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "cognito-idp:")])
    ]))
    error_message = "the Cognito statement's Resource must name one pool ARN with no wildcard"
  }
}

# Both inputs at once: the buckets' statements keep their place and the Cognito grant is still last,
# so the order is a property of the concat and not of which input happened to be set.
run "with_both_inputs_the_cognito_statement_is_still_last" {
  command = plan

  variables {
    additional_assets_bucket_arns = ["arn:aws:s3:::deploy-test-pipeline-assets"]
    user_pool_arn                 = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_Example1"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.actions.policy).Statement) == 8
    error_message = "five base statements, two per additional bucket and one for the pool: eight in total"
  }

  assert {
    condition = jsonencode(slice(jsondecode(aws_iam_role_policy.actions.policy).Statement, 0, 7)) == jsonencode(concat(var.golden_statements, [
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
    ]))
    error_message = "adding the pool must not disturb the base statements or the additional bucket's two"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role_policy.actions.policy).Statement[7].Action) == jsonencode(["cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient"])
    error_message = "the Cognito statement must be last, after every seed-bucket statement; got ${jsonencode(jsondecode(aws_iam_role_policy.actions.policy).Statement[7])}"
  }
}

# A pool ID rather than an ARN renders a policy that applies cleanly and authorizes nothing; the
# symptom would be an AccessDenied deep inside an apply. Refused at plan, on the variable.
run "a_pool_id_instead_of_an_arn_fails_at_plan" {
  command = plan

  variables {
    user_pool_arn = "us-east-1_Example1"
  }

  expect_failures = [var.user_pool_arn]
}

run "each_additional_bucket_appends_its_two_seed_statements_after_the_base" {
  command = plan

  variables {
    additional_assets_bucket_arns = ["arn:aws:s3:::deploy-test-pipeline-assets"]
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.actions.policy).Statement) == 7
    error_message = "one additional bucket must add exactly two statements"
  }

  # The first five are untouched, in place: the additions come after, never interleaved.
  assert {
    condition     = jsonencode(slice(jsondecode(aws_iam_role_policy.actions.policy).Statement, 0, 5)) == jsonencode(var.golden_statements)
    error_message = "the five original statements must be first and unchanged when a bucket is added"
  }

  # The same two grants the recon bucket gets, on the additional bucket: encryption read on the
  # bucket (the ETag-is-an-MD5 check), object read/write under it.
  assert {
    condition = jsonencode(slice(jsondecode(aws_iam_role_policy.actions.policy).Statement, 5, 7)) == jsonencode([
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
