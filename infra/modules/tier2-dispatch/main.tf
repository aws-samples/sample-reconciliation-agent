# ---------------------------------------------------------------------------------
# Tier-2 async dispatch: a concurrency-bounded state machine over the agent
# ---------------------------------------------------------------------------------
# Replaces the blocking fan-out from the Tier-1 stream consumer. The consumer now only opens the case
# PENDING; this module decides WHEN and HOW MANY investigations run.
#
# The shape that matters: the dispatcher hands the agent a Step Functions task token and returns in
# about a second, and the agent signals that token when it finishes. Nothing holds a connection open
# for the minutes an investigation takes, so the bound on concurrent investigations moves off Lambda
# concurrency (which now only measures dispatches) and onto the Map's MaxConcurrency, which counts
# paused children -- i.e. investigations actually in flight.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------------
# Shared role for the three small Lambdas (collect, dispatch, mark-failed)
# ---------------------------------------------------------------------------------
# One role, not three. They are all platform steps of a single workflow, none of them is reachable from
# outside it, and the union of their permissions is small and read-mostly. Three roles would be three
# places to keep the cases-table ARN in step for no isolation gained.

resource "aws_iam_role" "steps" {
  name               = "${var.name_prefix}-tier2-dispatch"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy" "steps" {
  name = "${var.name_prefix}-tier2-dispatch-policy"
  role = aws_iam_role.steps.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        # VPC-attached Lambda ENI management.
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
        ]
        Resource = "*"
      },
      {
        # Query for PENDING cases (GSI), and the guarded PENDING -> IN_PROGRESS / FAILED writes.
        Effect = "Allow"
        Action = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]
        Resource = [
          var.cases_table_arn,
          "${var.cases_table_arn}/index/*",
          var.audit_table_arn,
        ]
      },
      {
        # The run's collected item list. Write from collect, read by the Map's ItemReader.
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${var.runs_bucket_arn}/${var.runs_prefix}*"
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = "${var.agent_runtime_arn}*"
      },
      {
        # The backend selector, read once per run by collect.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:*:*:parameter/${var.name_prefix}/*"
      },
      {
        # The single-flight guard. MaxConcurrency is enforced PER MAP RUN, so without this two
        # overlapping runs each get a full allowance and together exceed the token budget. collect
        # lists RUNNING executions and collects nothing when another run is in flight.
        Effect   = "Allow"
        Action   = ["states:ListExecutions"]
        Resource = "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.name_prefix}-tier2"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
      },
      ],
      var.ingress_gateway_arn == "" ? [] : [{
        # Dispatch through the ingress gateway so every agent invocation passes one auditable entry
        # point a gateway resource policy can control.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = var.ingress_gateway_arn
    }])
  })
}

locals {
  # Shared by all three functions. The dispatcher ignores the table names and the collector ignores the
  # gateway settings; passing one map keeps them from drifting apart.
  step_env = {
    CASES_TABLE         = var.cases_table
    AUDIT_TABLE         = var.audit_table
    RUNS_BUCKET         = var.runs_bucket
    RUNS_PREFIX         = var.runs_prefix
    MAX_ITEMS_PER_RUN   = tostring(var.max_items_per_run)
    AGENT_BACKEND_PARAM = var.agent_backend_param
    # Built by hand rather than referencing aws_sfn_state_machine.tier2.arn: the state machine's role
    # grants lambda:InvokeFunction on these functions, so a real reference would close a cycle.
    STATE_MACHINE_ARN   = "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.name_prefix}-tier2"
    USE_INGRESS_GATEWAY = var.use_ingress_gateway ? "true" : "false"
    INGRESS_GATEWAY_URL = var.ingress_gateway_url
    INGRESS_TARGET_NAME = var.ingress_target_name
  }
}

# ---------------------------------------------------------------------------------
# collect: PENDING cases -> S3 (the Map's ItemReader input)
# ---------------------------------------------------------------------------------

resource "aws_lambda_function" "collect" {
  function_name    = "${var.name_prefix}-tier2-collect"
  role             = aws_iam_role.steps.arn
  runtime          = "python3.12"
  handler          = "backend.tier2_dispatch.collect.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash
  # Paginating a GSI query and writing one object. The ceiling is the S3 put, not the query.
  timeout     = 120
  memory_size = 256

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  environment {
    variables = local.step_env
  }
}

# ---------------------------------------------------------------------------------
# dispatch: start ONE investigation with a task token attached, then return
# ---------------------------------------------------------------------------------

resource "aws_lambda_function" "dispatch" {
  function_name    = "${var.name_prefix}-tier2-dispatch"
  role             = aws_iam_role.steps.arn
  runtime          = "python3.12"
  handler          = "backend.tier2_dispatch.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  # ⚠️ Sized for a dispatch, NOT for the agent's workload. This function serialises a request, signs
  # it, and returns; the agent then thinks for minutes on its own. A 900s timeout here (as on the
  # blocking worker) would only mean a bug had somewhere to hide.
  timeout     = 30
  memory_size = 256

  # No reserved_concurrent_executions, deliberately. Bounding ~1s dispatches bounds nothing about token
  # spend -- 14 slots would admit hundreds of concurrent investigations -- and would add queueing in
  # front of a state machine that is already rate-limiting itself via MaxConcurrency.

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  environment {
    variables = local.step_env
  }
}

# ---------------------------------------------------------------------------------
# claim / mark-failed: the two guarded case writes the map run performs
# ---------------------------------------------------------------------------------
# A Lambda rather than an ASL `dynamodb:updateItem` task, because both writes have real logic behind
# them: `can_transition` enforcement, a conditional write that makes a lost race a normal outcome, and
# an append-only audit row. Reimplementing that in ASL would be a second copy of the state machine's
# rules with no tests over it.

resource "aws_lambda_function" "case_step" {
  function_name    = "${var.name_prefix}-tier2-case-step"
  role             = aws_iam_role.steps.arn
  runtime          = "python3.12"
  handler          = "backend.tier2_dispatch.case_step.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash
  timeout          = 30
  memory_size      = 256

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  environment {
    variables = local.step_env
  }
}
