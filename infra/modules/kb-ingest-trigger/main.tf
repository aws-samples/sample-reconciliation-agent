####################################################################################
# Knowledge-base ingestion trigger: S3 notification -> delay queue -> one Lambda.
#
# The upload route puts a file and stops. A Bedrock knowledge base only reflects an S3
# prefix after an ingestion job scans it, so without this the file sits in the bucket
# and consult-guidance never finds it -- with no error anywhere, which is the same
# failure mode the seed-corpus ingestion note in infra/environments/recon/main.tf
# warns about.
#
# The delay and the single concurrency slot are both load-bearing, not tuning:
# StartIngestionJob is rejected while a job is in flight, and the Lambda's
# read-modify-write of a submission's `files` list has no conditional expression
# because it is the only writer.
####################################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Only operator uploads. The seeded corpus under knowledge-base/playbooks/ and
  # knowledge-base/retrieved_emails/ is ingested by the apply's own null_resource, and
  # notifying on the whole prefix would make every apply trigger a second, redundant job.
  upload_prefix = "knowledge-base/uploads/"
}

resource "aws_sqs_queue" "ingest_dlq" {
  #checkov:skip=CKV_AWS_27:Demo uses SQS-managed encryption (SSE-SQS, on by default); a customer-managed CMK adds key-management overhead not warranted here.
  name                      = "${var.name_prefix}-kb-ingest-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum. A message here means ingestion is stuck.
}

resource "aws_sqs_queue" "ingest" {
  #checkov:skip=CKV_AWS_27:Demo uses SQS-managed encryption (SSE-SQS, on by default); a customer-managed CMK adds key-management overhead not warranted here.
  name = "${var.name_prefix}-kb-ingest"

  # The debounce. Six files put in one second become six notifications; the delay lets them
  # accumulate into roughly one batch instead of six invocations racing to start the same job.
  delay_seconds = 60

  # Must be at least the Lambda's timeout, or SQS makes a message visible again while the
  # invocation that holds it is still running -- and a second copy would be started, which is
  # exactly what reserved concurrency 1 exists to prevent.
  visibility_timeout_seconds = 120

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    # Each pass returns the batch to the queue while work remains, so retries must be bounded or a
    # stuck job circulates forever. Twenty receives at a 120s timeout is about forty minutes.
    maxReceiveCount = 20
  })
}

# S3 needs explicit permission to put on the queue, and the two conditions are what stop any other
# bucket in the account doing the same.
resource "aws_sqs_queue_policy" "ingest" {
  queue_url = aws_sqs_queue.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.ingest.arn
      Condition = {
        ArnLike      = { "aws:SourceArn" = var.assets_bucket_arn }
        StringEquals = { "aws:SourceAccount" = local.account_id }
      }
    }]
  })
}

# ⚠️ aws_s3_bucket_notification is a WHOLE-BUCKET resource, not an additive one. A second instance
# pointed at the same bucket silently replaces this configuration rather than adding to it. Verified
# on 2026-09-02 that recon-dev-assets has no notification configuration at all
# (get-bucket-notification-configuration returns empty) and that no other resource in infra/ declares
# one -- so this is the bucket's single owner. If anything else ever needs a notification on this
# bucket, it must be added to THIS resource.
resource "aws_s3_bucket_notification" "uploads" {
  bucket = var.assets_bucket

  queue {
    queue_arn = aws_sqs_queue.ingest.arn
    # ObjectCreated:* rather than :Put -- the upload route uses CopyObject for the parts an email was
    # split into, and CopyObject raises ObjectCreated:Copy. Listening for :Put only would ingest a
    # plain PDF and silently ignore every document that came out of an email.
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = local.upload_prefix
  }

  depends_on = [aws_sqs_queue_policy.ingest]
}

resource "aws_iam_role" "kb_ingest" {
  name = "${var.name_prefix}-kb-ingest"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "kb_ingest" {
  name = "${var.name_prefix}-kb-ingest"
  role = aws_iam_role.kb_ingest.id
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
        # The event source mapping polls with THIS role, not the service's own.
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.ingest.arn
      },
      {
        # StartIngestionJob and the two reads the handler makes instead of trusting job statistics.
        Effect = "Allow"
        Action = [
          "bedrock:StartIngestionJob",
          "bedrock:ListIngestionJobs",
          "bedrock:ListKnowledgeBaseDocuments",
        ]
        Resource = "arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/${var.kb_id}"
      },
      {
        # Query needs the INDEX arn as well as the table arn; granting only the table answers
        # AccessDenied on the by_recency query with a message that names neither.
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:UpdateItem"]
        Resource = [var.uploads_table_arn, var.uploads_table_index_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "kb_ingest" {
  function_name    = "${var.name_prefix}-kb-ingest"
  role             = aws_iam_role.kb_ingest.arn
  runtime          = "python3.12"
  handler          = "backend.kb_ingest.handler.handler"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  # The handler never waits for an ingestion job, so this only has to cover a paginated document
  # list and a handful of table writes. It must stay BELOW the queue's visibility timeout.
  timeout = 60

  # ⚠️ Not tuning. The handler rewrites a submission's whole `files` list with no conditional
  # expression, and its docstring says that is safe because there is one writer. This is that
  # guarantee. Remove it and concurrent passes lose each other's status updates.
  reserved_concurrent_executions = 1

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  environment {
    variables = {
      # All four read with a loud failure on absent, never a default. A default would make the
      # Lambda ingest into the wrong knowledge base, or query a table named "" and report that
      # nothing is pending -- which looks exactly like a system with nothing to do.
      KB_ID             = var.kb_id
      KB_DATA_SOURCE_ID = var.kb_data_source_id
      UPLOADS_TABLE     = var.uploads_table_name
      ASSETS_BUCKET     = var.assets_bucket
    }
  }
}

resource "aws_lambda_event_source_mapping" "kb_ingest" {
  event_source_arn = aws_sqs_queue.ingest.arn
  function_name    = aws_lambda_function.kb_ingest.arn
  batch_size       = 10

  # Without this the handler's batchItemFailures response is DISCARDED and every message is deleted
  # as if it had succeeded. A file waiting on the job the handler just started would then never be
  # looked at again, and would stay PENDING_INGESTION until someone re-uploaded it.
  function_response_types = ["ReportBatchItemFailures"]
}
