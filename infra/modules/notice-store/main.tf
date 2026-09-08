####################################################################################
# Notice store: the ACTUAL side of the reconciliation. Counterparty notices that the
# document pipeline has already extracted, plus the search_notices query tool.
# Mirrors infra/modules/gl-mock/ (the EXPECTED side) in structure on purpose.
#
# Notices are REFERENCE data: a row here is evidence about a recon item, never the
# thing that created one. Nothing in this module writes to recon-items.
####################################################################################

resource "aws_dynamodb_table" "notices" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-notices"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "notice_id"

  attribute {
    name = "notice_id"
    type = "S"
  }
  attribute {
    name = "counterparty"
    type = "S"
  }
  attribute {
    name = "notice_date"
    type = "S"
  }
  attribute {
    name = "reference"
    type = "S"
  }

  # The two exact-match hints search_notices is most often given. Amount (tolerance) and fund
  # (alias resolution) are non-equality matches and stay filter expressions by necessity.
  global_secondary_index {
    name            = "counterparty-index"
    hash_key        = "counterparty"
    range_key       = "notice_date"
    projection_type = "ALL"
  }
  global_secondary_index {
    name            = "reference-index"
    hash_key        = "reference"
    projection_type = "ALL"
  }

  # NO stream. A stream is what makes recon-items case-creating; notices must never trigger one.
  point_in_time_recovery {
    enabled = true
  }
}

# ---------------------------------------------------------------------------------
# The search_notices query Lambda. Mirrors aws_lambda_function.gl_query in
# infra/modules/gl-mock/main.tf: same runtime, same shared backend zip, same optional
# vpc_config. Its grant is READ ONLY -- the IDP hook is the only writer to recon-notices.
# ---------------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}

resource "aws_iam_role" "notice_query" {
  name = "${var.name_prefix}-notice-query"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "notice_query" {
  name = "${var.name_prefix}-notice-query"
  role = aws_iam_role.notice_query.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # VPC-attached Lambda ENI create/delete -- scope to this account/region. Without these the
        # Lambda cannot be created at all when vpc_subnet_ids is set.
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
        # READ ONLY. search_notices is a retrieval tool; the IDP hook is the only writer.
        # Query covers both GSIs via the index ARNs.
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [
          aws_dynamodb_table.notices.arn,
          "${aws_dynamodb_table.notices.arn}/index/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "notice_query" {
  function_name    = "${var.name_prefix}-notice-query"
  role             = aws_iam_role.notice_query.arn
  runtime          = "python3.12"
  handler          = "backend.notice_tool.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash
  timeout          = 30

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  environment {
    variables = {
      # The handler reads os.environ["NOTICES_TABLE"] with no default: an unset value must fail
      # the invocation, not silently search a table named "".
      NOTICES_TABLE = aws_dynamodb_table.notices.name
    }
  }
}

# ---------------------------------------------------------------------------------
# There is deliberately NO seeding of this table.
#
# It once carried a create-only `aws_dynamodb_table_item` fixture, on the reasoning that tests and
# demos should not have to push documents through extraction to have an actual side. That reasoning
# did not survive: no test read the fixture (they write their own rows into a mock), and the document
# path -- upload route, extraction, hook, NoticeStore.put -- is wired end to end, so the fixture was a
# second ingestion path for data that has exactly one legitimate source.
#
# The consequence is accepted rather than worked around: a freshly applied environment has an EMPTY
# actual side, and the demo's first step is uploading a document. data/README.md says so, because
# an empty table read as a bug is the failure mode this note exists to prevent.
# ---------------------------------------------------------------------------------
