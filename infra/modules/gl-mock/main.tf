####################################################################################
# Mocked general ledger: synthetic GL entries in S3, a Glue table over them, an Athena
# workgroup, and the gl-query Lambda that runs bounded SELECTs. The Lambda serves two
# consumers: the AgentCore Gateway `general-ledger` tool (registered in the recon-agent
# module) and Tier-1's deterministic auto-clear lookup.
####################################################################################

# Used to scope IAM statements to this account/region.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  gl_prefix      = "general-ledger/"
  results_prefix = "athena-results/"
  account_id     = data.aws_caller_identity.current.account_id
  region         = data.aws_region.current.region
}

# Seed the GL entries CSV (repo-managed demo data; re-syncs on change).
resource "aws_s3_object" "gl_entries" {
  bucket       = var.assets_bucket
  key          = "${local.gl_prefix}gl-entries.csv"
  source       = "${var.gl_data_dir}/gl-entries.csv"
  etag         = filemd5("${var.gl_data_dir}/gl-entries.csv")
  content_type = "text/csv"
}

resource "aws_glue_catalog_database" "gl" {
  name = replace("${var.name_prefix}_gl", "-", "_")
}

resource "aws_glue_catalog_table" "gl_entries" {
  name          = "gl_entries"
  database_name = aws_glue_catalog_database.gl.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    EXTERNAL                 = "TRUE"
    "skip.header.line.count" = "1"
    classification           = "csv"
  }

  storage_descriptor {
    location      = "s3://${var.assets_bucket}/${local.gl_prefix}"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe"
      parameters            = { "field.delim" = "," }
    }

    dynamic "columns" {
      for_each = [
        { name = "entry_id", type = "string" },
        { name = "entry_date", type = "date" },
        { name = "value_date", type = "date" },
        { name = "account", type = "string" },
        { name = "borrower", type = "string" },
        { name = "facility", type = "string" },
        { name = "reference", type = "string" },
        { name = "description", type = "string" },
        { name = "amount", type = "double" },
        { name = "currency", type = "string" },
        { name = "entry_type", type = "string" },
      ]
      content {
        name = columns.value.name
        type = columns.value.type
      }
    }
  }
}

resource "aws_athena_workgroup" "gl" {
  name          = "${var.name_prefix}-gl"
  force_destroy = true

  configuration {
    result_configuration {
      output_location = "s3://${var.assets_bucket}/${local.results_prefix}"
      # Encrypt Athena query results at rest with S3-managed keys (no CMK needed).
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

# ---------------------------------------------------------------------------------
# gl-query Lambda (shared backend zip; handler backend.gl_tool.handler.handle)
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "gl_query" {
  name = "${var.name_prefix}-gl-query"
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

resource "aws_iam_role_policy" "gl_query" {
  name = "${var.name_prefix}-gl-query-policy"
  role = aws_iam_role.gl_query.id
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
        Effect   = "Allow"
        Action   = ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults"]
        Resource = aws_athena_workgroup.gl.arn
      },
      {
        # Glue catalog reads backing the Athena query — scope to this account's catalog and the GL
        # database + its tables.
        Effect = "Allow"
        Action = ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions"]
        Resource = [
          "arn:aws:glue:${local.region}:${local.account_id}:catalog",
          "arn:aws:glue:${local.region}:${local.account_id}:database/${aws_glue_catalog_database.gl.name}",
          "arn:aws:glue:${local.region}:${local.account_id}:table/${aws_glue_catalog_database.gl.name}/*",
        ]
      },
      {
        # Read the GL data + read/write Athena results under the assets bucket.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket"]
        Resource = [
          var.assets_bucket_arn,
          "${var.assets_bucket_arn}/${local.gl_prefix}*",
          "${var.assets_bucket_arn}/${local.results_prefix}*",
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

resource "aws_lambda_function" "gl_query" {
  function_name    = "${var.name_prefix}-gl-query"
  role             = aws_iam_role.gl_query.arn
  runtime          = "python3.12"
  handler          = "backend.gl_tool.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 30

  environment {
    variables = {
      GL_DATABASE      = aws_glue_catalog_database.gl.name
      GL_TABLE         = aws_glue_catalog_table.gl_entries.name
      ATHENA_WORKGROUP = aws_athena_workgroup.gl.name
      # Read handler overlays this status table onto its Athena results so a read reflects
      # any set_draw_status write. Empty/unset => no overlay (handler guards on it).
      GL_STATUS_TABLE = aws_dynamodb_table.gl_status.name
    }
  }
}

# ---------------------------------------------------------------------------------
# Draw/ledger status overlay: mutable DynamoDB table the authoritative (read-only) S3+Athena
# GL is overlaid with. set_draw_status writes here; search_ledger merges it onto reads.
# ---------------------------------------------------------------------------------

resource "aws_dynamodb_table" "gl_status" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic mock-GL data.
  name         = "${var.name_prefix}-gl-status"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "reference"

  attribute {
    name = "reference"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Let the gl-query (read) role read the overlay for the merge.
resource "aws_iam_role_policy" "gl_query_status_read" {
  name = "${var.name_prefix}-gl-query-status-read"
  role = aws_iam_role.gl_query.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:BatchGetItem"]
      Resource = aws_dynamodb_table.gl_status.arn
    }]
  })
}

# ---------------------------------------------------------------------------------
# set-draw-status Lambda (shared backend zip; handler backend.gl_tool.write_handler.handle).
# The `set-draw-status` Gateway write tool (registered in the recon-agent module).
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "set_draw_status" {
  name = "${var.name_prefix}-set-draw-status"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "set_draw_status" {
  name = "${var.name_prefix}-set-draw-status-policy"
  role = aws_iam_role.set_draw_status.id
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
        # Least-privilege: write ONLY the status overlay table.
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.gl_status.arn
      },
      # NOTE: the former cases-table (provenance) and SSM-threshold grants were removed —
      # both gates live at the GATEWAY now (Cedar Policy + REQUEST interceptor, verified in
      # ENFORCE mode 2026-07-26). This Lambda only writes the overlay row.
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "set_draw_status" {
  function_name    = "${var.name_prefix}-set-draw-status"
  role             = aws_iam_role.set_draw_status.arn
  runtime          = "python3.12"
  handler          = "backend.gl_tool.write_handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 30

  environment {
    variables = {
      GL_STATUS_TABLE = aws_dynamodb_table.gl_status.name
    }
  }
}

# Lake Formation governs this account's Glue catalog — IAM alone is not sufficient.
# Grant the query role LF permissions on the GL database/table.
resource "aws_lakeformation_permissions" "db" {
  principal   = aws_iam_role.gl_query.arn
  permissions = ["DESCRIBE"]

  database {
    name = aws_glue_catalog_database.gl.name
  }
}

resource "aws_lakeformation_permissions" "table" {
  principal   = aws_iam_role.gl_query.arn
  permissions = ["SELECT", "DESCRIBE"]

  table {
    database_name = aws_glue_catalog_database.gl.name
    name          = aws_glue_catalog_table.gl_entries.name
  }
}
