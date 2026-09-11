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
  attribute {
    name = "idp_record"
    type = "S"
  }
  attribute {
    name = "idp_started_at"
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

  # The Documents tab's list query: every IDP-ingested document over a date window, newest first.
  # Neither GSI above can answer that -- counterparty-index and reference-index are both keyed on a
  # notice-specific field the tab's query has no reason to know, not on ingest time.
  #
  # `idp_record`/`idp_started_at` are promoted to top-level attributes by
  # backend/recon_core/notices.py's `_idp_gsi_attrs` -- the ONE place that derivation happens, for
  # both row kinds the hook writes (extracted notices and tracking-only rows for documents it could
  # not map). Read that function's docstring before changing either name here.
  #
  # projection_type = ALL, not KEYS_ONLY: the list route needs whole rows, and a keys-only
  # projection would turn one Query into a Query plus N GetItems.
  #
  # hash_key = idp_record is a CONSTANT ("document" on every row this index carries), so the whole
  # index lives in a single partition. That is a known, accepted ceiling, not an oversight: at this
  # deployment's volume -- one write per processed document, a few hundred rows -- it sits far below
  # DynamoDB's per-partition ~3000 RCU / 1000 WCU limits. If this ever needs to scale past that, the
  # fix is a bucketed hash key (e.g. `document#YYYY-MM`), which costs the list route one Query per
  # month the requested window spans. Do NOT pre-build that bucketing now -- there is no volume that
  # justifies it yet, and it would just be complexity with no reader.
  #
  # The index is SPARSE by design: a row missing either `idp_record` or `idp_started_at` does not
  # appear here at all. That is correct, not a gap -- a seeded or structured-feed notice has no
  # pipeline execution behind it and does not belong on a tab about what the pipeline processed. See
  # `_idp_gsi_attrs` for the one place that absence is decided.
  global_secondary_index {
    name            = "idp-document-index"
    hash_key        = "idp_record"
    range_key       = "idp_started_at"
    projection_type = "ALL"
  }

  # NO stream. A stream is what makes recon-items case-creating; notices must never trigger one.
  point_in_time_recovery {
    enabled = true
  }
}

# ---------------------------------------------------------------------------------
# The notice SEARCH INDEX: an inverted index over every extracted field.
#
# The problem it solves. A GSI key attribute holds ONE value per item, so a single GSI cannot index
# twenty different fields of the same notice -- you would need one GSI per field, against a hard cap
# of twenty per table, each costing write throughput. That is why the two GSIs above index only
# `counterparty`/`notice_date` and `reference`, and why those three names are the only extracted field
# names recon hardcodes anywhere (see PROMOTED_EXTRACTED_FIELDS in backend/recon_core/notices.py).
#
# So the index lives in items of its own, in their own table. The key attributes are names RECON
# owns -- `search_field` and `search_value` -- and the extracted field's name is DATA in the first of
# them. Any field becomes an indexed lookup with no schema change, no Terraform edit and no rename
# risk, which is the whole point: recon may hardcode names it owns, never names the extraction
# configuration owns.
#
#     search_field = "counterparty"                                    <- from the extraction
#     search_value = "cindermoor logistics holdings, inc.#idp-Notice.pdf"
#
# A separate TABLE rather than more items in recon-notices: that table is hash-only on `notice_id`,
# so a second item kind would need a sort key added, which DynamoDB cannot do in place -- the table
# would have to be recreated. This also leaves the console's GetItem/BatchGetItem path and
# idp-document-index completely untouched.
#
# Partitioned on the field NAME with the value in the sort key, so one item shape serves both query
# kinds and the writer never has to know which fields will be range-queried:
#   * equality -> search_field = "cusip"      AND begins_with(search_value, "12345ab6#")
#   * range    -> search_field = "notice_date" AND search_value BETWEEN "2026-01-01" AND "2026-01-31#~"
#
# Partition sizing, checked rather than assumed. At 5,000 notices/month the busiest partition is the
# one for a field every notice carries: 180,000 items after three years at ~150 bytes each is ~27 MB
# against DynamoDB's 10 GB per-partition ceiling. Writes are the tighter limit and still nowhere
# close -- 5,000 notices arriving in a single 15-minute batch is ~6 WCU/s on that partition against a
# 1,000 WCU/s cap.
# ---------------------------------------------------------------------------------

resource "aws_dynamodb_table" "notice_search" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-notice-search"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "search_field"
  range_key    = "search_value"

  attribute {
    name = "search_field"
    type = "S"
  }
  attribute {
    name = "search_value"
    type = "S"
  }

  # NO stream and NO GSI. This table is only ever read by its own keys -- it IS the index.
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
        # Query covers both GSIs via the index ARNs. BatchGetItem is how the index path fetches the
        # notices a posting-list intersection selected -- one call per 100 ids instead of N GetItems.
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [
          aws_dynamodb_table.notices.arn,
          "${aws_dynamodb_table.notices.arn}/index/*",
          aws_dynamodb_table.notice_search.arn,
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
      # The handler reads both with no default: an unset value must fail the invocation, not silently
      # search a table named "".
      NOTICES_TABLE       = aws_dynamodb_table.notices.name
      NOTICE_SEARCH_TABLE = aws_dynamodb_table.notice_search.name
    }
  }
}

# ---------------------------------------------------------------------------------
# There is deliberately NO seeding of this table, and adding a fixture row would be a mistake.
#
# A notice has exactly one legitimate source: the document path (upload route -> extraction -> IDP
# hook -> NoticeStore.put), which is wired end to end. A seeded `aws_dynamodb_table_item` would be a
# second ingestion path for the same data, and tests do not need one — they write their own rows into
# a mock.
#
# The consequence is accepted rather than worked around: a freshly applied environment has an EMPTY
# actual side, and the demo's first step is uploading a document. data/README.md says so, because an
# empty table read as a bug is the failure mode this note exists to prevent.
# ---------------------------------------------------------------------------------
