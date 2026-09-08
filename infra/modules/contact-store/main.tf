####################################################################################
# Contact store: who the platform may email, and in what words. Two tables plus the
# read-only Lambda behind the list_contacts / list_templates gateway tools.
#
# Both tables are CONFIGURATION an operator edits from the Config tab while the system
# is running. Everything downstream reads them at the moment of use rather than at
# deploy time, which is what makes deactivating a contact a revocation instead of a
# request to redeploy. Nothing here is cached anywhere.
#
# Modelled on infra/modules/notice-store/. Same shape, same create-only seeding, and
# deliberately NO stream on either table -- a stream is what makes a table
# case-creating, and a recipient list must never open a recon case.
####################################################################################

resource "aws_dynamodb_table" "contacts" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-contacts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "contact_id"

  attribute {
    name = "contact_id"
    type = "S"
  }

  # No GSI on `kind`. Every reader wants the whole active list (the interceptor's authorization set,
  # the Config tab, the agent's picker), so a Scan is the access pattern rather than a fallback --
  # and a recipient list is tens of rows, not thousands. `active` could not be a key attribute
  # anyway: it is a BOOLEAN, which DynamoDB will not index.
  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "templates" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-email-templates"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "template_id"

  attribute {
    name = "template_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---------------------------------------------------------------------------------
# The list_contacts / list_templates Lambda. ONE function behind TWO gateway targets
# (the caller creates those): AgentCore composes the exposed tool name as
# <target>___<tool>, and the design names the tools contacts___list_contacts and
# templates___list_templates -- two prefixes, so two targets. Sharing the function
# keeps the "never return an address" projection in a single deployable.
# ---------------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # The seeded internal-notification contact's id, defined ONCE. It is both the seed row's key and
  # the NOTIFY_CONTACT_ID handed to the agent runtime and the Tier-1 Lambda, and the two must agree:
  # `maybe_auto_resolve` catches an unresolvable contact as best-effort, so a mismatch does not fail
  # an apply or a case -- resolution notifications simply stop arriving, silently.
  notify_contact_id = "notify-primary"
}

resource "aws_iam_role" "contact_query" {
  name = "${var.name_prefix}-contact-query"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "contact_query" {
  name = "${var.name_prefix}-contact-query"
  role = aws_iam_role.contact_query.id
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
        # READ ONLY, and that is the whole security posture of the agent-facing surface: there is no
        # write tool on the gateway, so the agent has no path to add a recipient. Withholding the
        # tool is stronger than offering it and denying it in Cedar -- a forbid on a tool that does
        # not exist is a comment, not a control. The Config tab writes with the ECS task role.
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [
          aws_dynamodb_table.contacts.arn,
          aws_dynamodb_table.templates.arn,
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

resource "aws_lambda_function" "contact_query" {
  function_name    = "${var.name_prefix}-contact-query"
  role             = aws_iam_role.contact_query.arn
  runtime          = "python3.12"
  handler          = "backend.contacts.handler.handle"
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
      # Both read with os.environ[...] and no default: an unset value must fail the invocation.
      # A default would Scan a table named "" and report an empty recipient list, which reads
      # exactly like an operator who has not added anyone yet.
      CONTACTS_TABLE  = aws_dynamodb_table.contacts.name
      TEMPLATES_TABLE = aws_dynamodb_table.templates.name
    }
  }
}

# ---------------------------------------------------------------------------------
# Create-only seeding, so the deploy has a working notification recipient and one
# template per purpose without an operator's later edits being reverted. The
# `ignore_changes = [item]` is what makes that true: without it every apply would
# undo a Config-tab change, including a deactivation.
# ---------------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "notify_contact_seed" {
  count = var.notify_email == "" ? 0 : 1

  table_name = aws_dynamodb_table.contacts.name
  hash_key   = aws_dynamodb_table.contacts.hash_key

  item = jsonencode({
    contact_id   = { S = local.notify_contact_id }
    display_name = { S = "Reconciliation Operations" }
    email        = { S = var.notify_email }
    kind         = { S = "internal_notification" }
    active       = { BOOL = true }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table_item" "template_seed" {
  for_each = {
    counterparty = {
      template_id = "tpl-counterparty-reference"
      name        = "Ask a counterparty to confirm a payment reference"
      purpose     = "counterparty"
      subject     = "Reference confirmation: {{reference}}"
      body = join("\n", [
        "Hello,",
        "",
        "We received {{amount}} on {{value_date}} but cannot match it to an open item.",
        "Could you confirm the payment reference for {{reference}}?",
        "",
        "Thank you,",
        "Reconciliation Operations",
      ])
      # EXACTLY the {{placeholders}} the subject and body above contain. This list is what the
      # agent is shown and what it must supply values for; the platform substitutes these names and
      # nothing else. Add a placeholder to the body without adding it here and the draft renders
      # with the raw {{name}} still in it, so the two sides must be edited together.
      variables = ["reference", "amount", "value_date"]
    }
    internal_notification = {
      template_id = "tpl-internal-resolved"
      name        = "Tell the team a case resolved"
      purpose     = "internal_notification"
      subject     = "[Recon] Resolved: {{item_id}}"
      body = join("\n", [
        "Case {{item_id}} resolved as: {{resolution}}",
        "",
        "Confidence: {{confidence}}",
      ])
      variables = ["item_id", "resolution", "confidence"]
    }
  }

  table_name = aws_dynamodb_table.templates.name
  hash_key   = aws_dynamodb_table.templates.hash_key

  item = jsonencode({
    template_id      = { S = each.value.template_id }
    name             = { S = each.value.name }
    purpose          = { S = each.value.purpose }
    subject_template = { S = each.value.subject }
    body_template    = { S = each.value.body }
    variables        = { L = [for v in each.value.variables : { S = v }] }
    active           = { BOOL = true }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
