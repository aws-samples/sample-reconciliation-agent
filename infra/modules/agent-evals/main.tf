####################################################################################
# agent-evals module: AgentCore evaluator + online evaluation config + results log.
# Uses native TF resources (aws_bedrockagentcore_evaluator, online_evaluation_config)
# — provider ~>6.51 verified to have them (spike_evals.md).
####################################################################################

data "aws_caller_identity" "current" {}

locals {
  account_id     = data.aws_caller_identity.current.account_id
  evaluator_name = "${replace(var.name_prefix, "-", "_")}_analyst_agreement"
  config_name    = "${replace(var.name_prefix, "-", "_")}_online_eval"
}

# ---------------------------------------------------------------------------------
# Agreement evaluator Lambda (custom code-based, SESSION level)
# ---------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "evaluator_lambda" {
  name               = "${var.name_prefix}-eval-agreement"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "evaluator_lambda" {
  name = "${var.name_prefix}-eval-agreement-policy"
  role = aws_iam_role.evaluator_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Scan: lessons are keyed by RAW item id but session ids carry the SANITIZED form
        # (dots forbidden), so the evaluator matches by scanning and sanitizing each row's
        # item_id — a keyed lookup cannot express that. Demo-scale table.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = var.lessons_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
      {
        # VPC-Lambda ENI creation/deletion — scope to this account/region.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${var.region}:${local.account_id}:*"
      },
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (must be "*").
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "evaluator" {
  function_name    = "${var.name_prefix}-eval-agreement"
  role             = aws_iam_role.evaluator_lambda.arn
  runtime          = "python3.12"
  handler          = "backend.eval_agreement.handler.handle"
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
      LESSONS_TABLE = var.lessons_table
    }
  }
}

# Allow the AgentCore evaluations service to invoke the Lambda.
# source_account confines the grant to this account, closing the cross-account confused-deputy
# hole (a bare service principal with no source lets any account's resource invoke us).
# source_arn is scoped to this account's bedrock-agentcore resources (a wildcard on the
# evaluator ARN itself would create a dependency cycle, since the evaluator already references
# this Lambda's ARN).
resource "aws_lambda_permission" "evaluator_invoke" {
  statement_id   = "AllowAgentCoreEval"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.evaluator.function_name
  principal      = "bedrock-agentcore.amazonaws.com"
  source_account = local.account_id
  source_arn     = "arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:*"
}

# ---------------------------------------------------------------------------------
# AgentCore Evaluator registration (custom code-based, SESSION level)
# ---------------------------------------------------------------------------------

resource "aws_bedrockagentcore_evaluator" "agreement" {
  evaluator_name = local.evaluator_name
  description    = "Analyst-agreement: scores sessions against the lessons ledger ground truth."

  evaluator_config {
    code_based {
      lambda_config {
        lambda_arn                = aws_lambda_function.evaluator.arn
        lambda_timeout_in_seconds = 30
      }
    }
  }

  level = "SESSION"
}

# ---------------------------------------------------------------------------------
# Evaluation execution role (online eval config needs it)
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "eval_exec" {
  name = "${var.name_prefix}-eval-exec"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "bedrock-agentcore.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "eval_exec" {
  name = "${var.name_prefix}-eval-exec-policy"
  role = aws_iam_role.eval_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read harness OTel traces from CloudWatch (aws/spans is account-wide; grant broadly).
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults", "logs:DescribeLogGroups", "logs:GetLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
      {
        # Invoke + inspect the custom evaluator Lambda (service validates GetFunction at create).
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction", "lambda:GetFunction"]
        Resource = aws_lambda_function.evaluator.arn
      },
      {
        # Builtin LLM-judge evaluators need model access — scope to all foundation models
        # (region-agnostic) and this account/region's inference profiles.
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/*",
        ]
      },
      {
        # Write evaluation results — the service creates its own log group with a generated name
        # (/aws/bedrock-agentcore/evaluations/results/<configName>-<suffix>), so grant broadly.
        # PutRetentionPolicy/TagResource are part of the same unconditional provisioning chain
        # the batch path exercises under the caller's FAS (see the matching comment in
        # module.frontend); the online path has not failed on them, but it runs the same
        # service-side group provisioning, so keep the two roles' grants identical rather than
        # waiting to discover the asymmetry in production.
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
          "logs:PutRetentionPolicy", "logs:TagResource",
        ]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
      {
        # Publish metrics.
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "Bedrock-AgentCore/Evaluations" } }
      },
    ]
  })
}

# NOTE: no results log group is created here — output_config on the online eval config is
# computed-only, so the service writes per-session records to log groups it names itself:
# /aws/bedrock-agentcore/evaluations/results/<configName>-<suffix>, one per config. The BFF
# discovers them by prefix (see results_log_group_prefix output).

# ---------------------------------------------------------------------------------
# Online evaluation configs (4 evaluators, sampling 100%, auto-enabled).
# One config per agent backend: the service caps dataSourceConfig serviceNames at a
# single entry per config, so multi-backend scoring requires a config per service name.
# All configs publish to the same Bedrock-AgentCore/Evaluations metrics namespace,
# so the Evals tab aggregates across backends without changes.
# NOTE: the service rejects concurrent create/update of configs sharing an evaluator
# (ConflictException) — recreate with `terraform apply -parallelism=1`.
# ---------------------------------------------------------------------------------

resource "aws_bedrockagentcore_online_evaluation_config" "this" {
  for_each = var.service_names

  online_evaluation_config_name = "${local.config_name}_${each.key}"
  description                   = "Continuous evaluation of recon agent sessions (${each.key} backend)."

  evaluator {
    evaluator_id = aws_bedrockagentcore_evaluator.agreement.evaluator_id
  }
  evaluator {
    evaluator_id = "Builtin.GoalSuccessRate"
  }
  evaluator {
    evaluator_id = "Builtin.Helpfulness"
  }
  evaluator {
    evaluator_id = "Builtin.Correctness"
  }

  data_source_config {
    cloudwatch_logs {
      # Spans group + this backend's event-record group (see event_log_groups variable note).
      log_group_names = compact([var.harness_log_group_name, lookup(var.event_log_groups, each.key, "")])
      service_names   = [each.value]
    }
  }

  rule {
    sampling_config {
      sampling_percentage = 100
    }
    session_config {
      session_timeout_minutes = 5
    }
  }

  evaluation_execution_role_arn = aws_iam_role.eval_exec.arn
  enable_on_create              = true
}
