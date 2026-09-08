####################################################################################
# Email pre-processor: one .msg or .eml in, a manifest of derived documents out.
#
# Synchronous, invoked only by the console's upload route. It exists because Lambda
# caps a synchronous request payload at 6 MB while the upload allowlist permits
# 100 MB, so file bytes cannot cross the invoke boundary. The route stages the raw
# email in S3 and passes a key; only the manifest comes back.
#
# No trigger, no event source, no schedule. If this function is running, an operator
# is uploading an email right now.
####################################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}

resource "aws_iam_role" "preprocess" {
  name = "${var.name_prefix}-email-preprocess"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "preprocess" {
  name = "preprocess-policy"
  role = aws_iam_role.preprocess.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read the staged email only. Not the whole bucket: the same bucket holds the skills
        # catalog, the system prompt and the knowledge-base corpus, and an email parser has no
        # business reading any of them.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${var.assets_bucket_arn}/uploads/inbox/*"
      },
      {
        # Write the derived parts, still inside recon's own bucket. The route copies them onward,
        # so this function needs no grant on the document pipeline's bucket or the KB prefix.
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${var.assets_bucket_arn}/uploads/derived/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*"
      },
      {
        # ENI lifecycle for the VPC attachment. DescribeNetworkInterfaces takes no resource ARN and
        # must be "*" -- scoping it is what makes a VPC-attached function fail to start.
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "preprocess" {
  function_name    = "${var.name_prefix}-email-preprocess"
  role             = aws_iam_role.preprocess.arn
  runtime          = "python3.12"
  handler          = "backend.email_preprocess.handler.handler"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  # 100 MB is the largest upload the policy permits, and `extract_msg` holds the whole container in
  # memory while it walks it. 2048 MB is also what buys the CPU: Lambda scales vCPU with memory, and
  # rendering a long plain-text body to PDF is the slow part.
  timeout     = 120
  memory_size = 2048

  environment {
    variables = {
      UPLOAD_STAGING_BUCKET = var.assets_bucket
    }
  }
}
