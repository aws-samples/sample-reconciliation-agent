# Run from this module's directory: `terraform init && terraform test`.
#
# The AWS provider is MOCKED: nothing is created, no credentials are read. Mock providers still
# need the provider binary for its schema, hence the init. Every assertion below is about the
# relationship between what a Lambda is told (its environment) and what its role lets it do --
# the invariant main.tf states, "a prefix rename cannot leave a grant behind" -- and about the
# parser role holding exactly the DynamoDB and S3 rights its handler exercises.

mock_provider "aws" {
  # The provider's schema validation still runs under a mock, and the mock's default for a computed
  # attribute is a random string, which fails the ARN checks on aws_lambda_function.role and
  # memory_execution_role_arn and the JSON check on assume_role_policy. Hence well-formed values.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/deal-pipeline-test-mock"
    }
  }
  override_data {
    target = data.aws_iam_policy_document.lambda_assume
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
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
  # Realistic ARNs so the assertions can tell the two tables apart and can join a bucket ARN to
  # an env-var prefix; the mock's default is a random string.
  override_resource {
    target = aws_dynamodb_table.emails
    values = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/deal-pipeline-test-emails"
    }
  }
  override_resource {
    target = aws_dynamodb_table.deals
    values = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/deal-pipeline-test-deals"
    }
  }
  override_resource {
    target = aws_s3_bucket.assets
    values = {
      arn = "arn:aws:s3:::deal-pipeline-test-assets-123456789012"
    }
  }
}

variables {
  name_prefix        = "deal-pipeline-test"
  lambda_zip         = "never-read-under-a-mock-provider.zip"
  lambda_source_hash = "dGVzdA=="
}

run "parser_role_grants_exactly_what_parser_handler_calls" {
  # emails table: get_item + update_item (status transitions). Never PutItem -- the BFF creates
  # emails -- and never Query.
  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_role_policy.parser.policy).Statement : s.Action
      if contains(flatten([s.Resource]), aws_dynamodb_table.emails.arn)
    ])) == toset(["dynamodb:GetItem", "dynamodb:UpdateItem"])
    error_message = "the parser's emails-table statement must grant GetItem and UpdateItem only"
  }

  # deals table: put_item (stage), update_item (supersede on re-parse), query on by_email (find
  # the deals to supersede). Never GetItem or Scan.
  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_role_policy.parser.policy).Statement : s.Action
      if contains(flatten([s.Resource]), aws_dynamodb_table.deals.arn)
    ])) == toset(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"])
    error_message = "the parser's deals-table statement must grant PutItem, UpdateItem and Query only"
  }

  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_role_policy.parser.policy).Statement : flatten([s.Resource])
      if contains(flatten([s.Resource]), aws_dynamodb_table.deals.arn)
    ])) == toset([aws_dynamodb_table.deals.arn, "${aws_dynamodb_table.deals.arn}/index/by_email"])
    error_message = "the parser's Query grant must name the by_email index, not index/*"
  }

  # The parser reads the email body from DynamoDB; the emails/ prefix in S3 is the BFF's copy.
  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.parser.policy).Statement : concat(
        [for r in flatten([s.Resource]) : strcontains(r, "/emails/")],
        [for p in try(s.Condition.StringLike["s3:prefix"], []) : startswith(p, "emails/")],
      )
    ]))
    error_message = "the parser role must not be able to read or list emails/ in S3"
  }
}

run "every_s3_location_a_lambda_is_given_is_one_its_role_can_read" {
  # Parser: SKILLS_PREFIX, PARSER_PROMPT_KEY and SECURITY_MASTER_PREFIX each fall under one of its
  # GetObject resources. A prefix renamed in main.tf's locals moves both sides; a prefix typed by
  # hand in only one place fails here.
  assert {
    condition = alltrue([
      for location in [
        aws_lambda_function.parser.environment[0].variables["SKILLS_PREFIX"],
        aws_lambda_function.parser.environment[0].variables["PARSER_PROMPT_KEY"],
        aws_lambda_function.parser.environment[0].variables["SECURITY_MASTER_PREFIX"],
        ] : anytrue([
          for r in flatten([
            for s in jsondecode(aws_iam_role_policy.parser.policy).Statement : s.Resource
            if contains(s.Action, "s3:GetObject")
          ]) : startswith("${aws_s3_bucket.assets.arn}/${location}", trimsuffix(r, "*"))
      ])
    ])
    error_message = "every S3 prefix or key in the parser's environment must be covered by one of its s3:GetObject resources"
  }

  # OMS upload: the handler reads COUNTERPARTIES_KEY (the exact key of the canonical counterparty
  # list) and must be able to GetObject it. This is the env var the handler actually reads; a
  # role that grants the prefix while the function is handed a different variable name is the
  # drift this guards against.
  assert {
    condition     = aws_lambda_function.oms_upload.environment[0].variables["COUNTERPARTIES_KEY"] == "security-master/counterparties.csv"
    error_message = "COUNTERPARTIES_KEY must be the design §3 key security-master/counterparties.csv"
  }

  assert {
    condition = anytrue([
      for r in flatten([
        for s in jsondecode(aws_iam_role_policy.oms_upload.policy).Statement : s.Resource
        if contains(s.Action, "s3:GetObject")
      ]) : startswith("${aws_s3_bucket.assets.arn}/${aws_lambda_function.oms_upload.environment[0].variables["COUNTERPARTIES_KEY"]}", trimsuffix(r, "*"))
    ])
    error_message = "the OMS upload role must be able to GetObject the key it is given in COUNTERPARTIES_KEY"
  }

  assert {
    condition     = toset(keys(aws_lambda_function.oms_upload.environment[0].variables)) == toset(["DEALS_TABLE", "ASSETS_BUCKET", "COUNTERPARTIES_KEY"])
    error_message = "the OMS upload environment is exactly DEALS_TABLE, ASSETS_BUCKET, COUNTERPARTIES_KEY -- a new variable here needs a matching grant and a matching read in oms_upload_handler.py"
  }
}

run "oms_upload_role_stays_a_validator" {
  # No ListBucket (a missing seed must fail loudly, see lambdas.tf) and no PutItem (the
  # validator must never be able to create a deal).
  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.oms_upload.policy).Statement :
      [for a in s.Action : contains(["s3:ListBucket", "dynamodb:PutItem", "dynamodb:Scan", "dynamodb:Query"], a)]
    ]))
    error_message = "the OMS upload role must not hold s3:ListBucket, dynamodb:PutItem, dynamodb:Scan or dynamodb:Query"
  }
}
