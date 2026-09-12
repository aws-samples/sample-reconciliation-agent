####################################################################################
# The two Python Lambdas (design §2). Both run from the ONE zip the lambda-package module
# builds (root contains the backend/ package), so handlers are addressed as
# backend.deal_pipeline.<module>.handle. The handlers need boto3 (supplied by the runtime), the
# standard library and tzdata; which wheels the zip vendors is the ROOT's decision, because one
# zip may also serve other Lambdas (the recon root shares its zip with these two).
####################################################################################

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  parser_function_name     = "${var.name_prefix}-parser"
  oms_upload_function_name = "${var.name_prefix}-oms-upload"
}

# Log groups are created BEFORE the functions (depends_on below) so they carry the retention setting.
# Left to Lambda, the group is auto-created on first invoke with retention "never expire", and a later
# Terraform import would be needed to fix it. modules/lambda-logs is the module the recon root uses
# for its own Lambdas' groups; it is keyed here by label rather than by function name so the two
# `moved` blocks below can name the new addresses (a moved index key must be a literal, and the
# function names are built from var.name_prefix).
module "lambda_logs" {
  source = "../lambda-logs"

  lambda_functions_by_key = {
    parser     = local.parser_function_name
    oms_upload = local.oms_upload_function_name
  }
  log_retention_days = var.log_retention_days
}

# The two groups were resources of this module before they moved into modules/lambda-logs. Same name,
# same retention, so an existing deployment keeps its groups (and their retained logs) rather than
# destroying and recreating them under the new addresses.
moved {
  from = aws_cloudwatch_log_group.parser
  to   = module.lambda_logs.aws_cloudwatch_log_group.lambda["parser"]
}

moved {
  from = aws_cloudwatch_log_group.oms_upload
  to   = module.lambda_logs.aws_cloudwatch_log_group.lambda["oms_upload"]
}

# ---------------------------------------------------------------------------------
# Parser: Bedrock Converse tool loop that turns an email into a deal record + staging CSV
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "parser" {
  name               = local.parser_function_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "parser" {
  name = "${local.parser_function_name}-policy"
  role = aws_iam_role.parser.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read the email (the parser takes the body from the table, not from S3) and move it
        # RECEIVED -> PARSING -> PARSED / PARSE_FAILED. No PutItem: only the BFF creates emails.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.emails.arn
      },
      {
        # Stage the new deal and, on re-parse, Query by_email for the email's still-open deals
        # and UpdateItem them to REJECTED (superseded). No GetItem or Scan: the parser never
        # reads a deal back, and the BFF is the only component that lists them.
        Effect = "Allow"
        Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = [
          aws_dynamodb_table.deals.arn,
          "${aws_dynamodb_table.deals.arn}/index/${local.deals_by_email_index}",
        ]
      },
      {
        # Discover skills/ and read every S3 input the run needs. Object-level and prefix-scoped
        # so the model's process cannot read the OMS staging area, another deal's CSV, or the raw
        # email bodies under emails/ (those are the BFF's copy; the parser has the same text from
        # the emails table).
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.assets.arn}/${local.skills_prefix}*",
          "${aws_s3_bucket.assets.arn}/${local.prompts_prefix}*",
          "${aws_s3_bucket.assets.arn}/${local.security_master_prefix}*",
        ]
      },
      {
        # ListBucket authorizes on the BUCKET arn; the prefix condition is what confines it to the
        # same three prefixes as the GetObject grant. The env vars below carry these prefixes with
        # their trailing slash, so a listing with prefix "skills/" matches "skills/*".
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.assets.arn
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "${local.skills_prefix}*",
              "${local.prompts_prefix}*",
              "${local.security_master_prefix}*",
            ]
          }
        }
      },
      {
        # The staging CSV the review screen downloads and the mock OMS validates.
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.assets.arn}/${local.deal_csv_prefix}*"
      },
      {
        # Same shape as the memory role: the model is runtime-selectable from the Config tab, so
        # the grant covers every foundation model and this account's inference profiles.
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/*",
        ]
      },
      {
        # Recall consolidated edge-case rules before the first model call. Retrieve only: the
        # parser never writes memory; the assistant's save_memory tool does that with the
        # developer's credentials through the BFF.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:RetrieveMemoryRecords"]
        Resource = [module.knowledge_memory.memory_arn, "${module.knowledge_memory.memory_arn}/*"]
      },
      {
        # The one Config-tab value the parser reads per invocation. Enumerated rather than
        # path-scoped: this role holds the model's own credentials, and a wildcard over the prefix
        # would hand it every parameter added under it later.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.agent_model_id.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${module.lambda_logs.log_group_arns["parser"]}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "parser" {
  function_name    = local.parser_function_name
  role             = aws_iam_role.parser.arn
  runtime          = "python3.12"
  architectures    = ["x86_64"]
  handler          = "backend.deal_pipeline.parser_handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash
  # A tool loop of several Converse round-trips plus a memory retrieval; 5 minutes is headroom,
  # not a target. 1 GB because Lambda CPU scales with memory and the run is dominated by JSON
  # handling between model calls.
  timeout     = 300
  memory_size = 1024

  environment {
    variables = {
      EMAILS_TABLE           = aws_dynamodb_table.emails.name
      DEALS_TABLE            = aws_dynamodb_table.deals.name
      ASSETS_BUCKET          = aws_s3_bucket.assets.bucket
      KNOWLEDGE_MEMORY_ID    = module.knowledge_memory.memory_id
      AGENT_MODEL_PARAM      = aws_ssm_parameter.agent_model_id.name
      SKILLS_PREFIX          = local.skills_prefix
      PARSER_PROMPT_KEY      = local.parser_prompt_key
      SECURITY_MASTER_PREFIX = local.security_master_prefix
      # The parser recalls under the desk's fixed actor; the strategy namespace is
      # deal-pipeline/edge-cases/{actorId} and the desk's actorId is deal-desk (design §8).
      MEMORY_NAMESPACE = "deal-pipeline/edge-cases/deal-desk"
    }
  }

  depends_on = [module.lambda_logs]
}

# The BFF invokes the parser asynchronously (InvocationType=Event), and async invocations retry
# TWICE by default. That is the wrong default for an LLM-driven parse: a failure has already been
# recorded on the email as PARSE_FAILED for the inbox to show, and the Reparse button is the
# intended retry. An automatic retry would flip that email back to PARSING behind the operator's
# back, run the model again at full cost, and -- because every run stages a new deal and
# supersedes the email's open ones -- could reject a deal the desk was in the middle of reviewing.
resource "aws_lambda_function_event_invoke_config" "parser" {
  function_name          = aws_lambda_function.parser.function_name
  maximum_retry_attempts = 0
}

# ---------------------------------------------------------------------------------
# Mock OMS upload: validates a staging CSV, copies accepted files to oms-staging/
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "oms_upload" {
  name               = local.oms_upload_function_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "oms_upload" {
  name = "${local.oms_upload_function_name}-policy"
  role = aws_iam_role.oms_upload.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read the deal being uploaded and record the UploadResult on it. No PutItem: the
        # validator must never be able to create a deal.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.deals.arn
      },
      {
        # The CSV under review plus the canonical counterparty list (COUNTERPARTIES_KEY below) the
        # LEFT_AGENT_UNKNOWN rule checks against. Granted at the security-master prefix -- the
        # same local the key is derived from -- so a prefix rename moves key and grant together.
        #
        # Deliberately no s3:ListBucket: without it a missing object answers 403 rather than 404,
        # which the handler surfaces as a hard failure. That is the right outcome here -- the
        # counterparty CSV is a committed seed that tracks the repo, so its absence means the
        # apply did not finish, and validating against an empty list would instead reject every
        # deal with a misleading LEFT_AGENT_UNKNOWN.
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.assets.arn}/${local.deal_csv_prefix}*",
          "${aws_s3_bucket.assets.arn}/${local.security_master_prefix}*",
        ]
      },
      {
        # Accepted files only. The validator cannot touch deal-csv/, so a rejected upload leaves
        # the staging CSV exactly as the reviewer approved it.
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.assets.arn}/${local.oms_staging_prefix}*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${module.lambda_logs.log_group_arns["oms_upload"]}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "oms_upload" {
  function_name    = local.oms_upload_function_name
  role             = aws_iam_role.oms_upload.arn
  runtime          = "python3.12"
  architectures    = ["x86_64"]
  handler          = "backend.deal_pipeline.oms_upload_handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash
  # Pure validation of a one-row CSV; invoked synchronously by the approve route, so the timeout
  # doubles as the reviewer's worst-case wait.
  timeout     = 60
  memory_size = 512

  environment {
    variables = {
      DEALS_TABLE   = aws_dynamodb_table.deals.name
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      # The exact key of the OMS canonical counterparty list (design §3), not a prefix: the
      # validator needs this one file and nothing else from security-master/. Derived from the
      # prefix local so the GetObject grant above and this key cannot drift apart.
      COUNTERPARTIES_KEY = local.counterparties_key
    }
  }

  depends_on = [module.lambda_logs]
}
