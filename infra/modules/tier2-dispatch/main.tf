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

# ---------------------------------------------------------------------------------
# IAM propagation barrier
# ---------------------------------------------------------------------------------
# ⚠️ Load-bearing on a FIRST apply, and invisible on every later one — which is exactly why it needs a
# comment rather than being quietly deleted as dead weight.
#
# Lambda validates the execution role's permissions synchronously inside CreateFunction, so a
# VPC-attached function created moments after its role policy fails with:
#
#   InvalidParameterValueException: The provided execution role does not have permissions
#   to call CreateNetworkInterface on EC2
#
# `depends_on` alone does NOT fix this. On 2026-09-11 all three functions below failed that way with
# the policy already reporting "Creation complete after 1s" earlier in the same apply: the ordering was
# right and IAM simply had not propagated yet. Every other VPC-attached Lambda in this repo escapes it
# only because its role has existed since an earlier apply; this module creates role, policy and
# functions in one pass, so it is the first place that races.
#
# A sleep provisioner rather than `hashicorp/time`: the environment's `required_providers` block argues
# deliberately for a minimal provider set, and `local-exec` is already the established mechanism here
# (see modules/lambda-package and modules/recon-agent). Nothing is destroyed or recreated by this on a
# steady-state apply — `triggers_replace` follows the policy, so it re-runs only when the policy body
# actually changes.
resource "terraform_data" "iam_propagation" {
  triggers_replace = {
    policy = aws_iam_role_policy.steps.policy
  }

  provisioner "local-exec" {
    command = "sleep 30"
  }

  depends_on = [aws_iam_role_policy.steps]
}

locals {
  # Client-side OTel tracing for the DISPATCHER. Mirrors modules/tier1's block deliberately: the layer
  # is what PROVIDES the opentelemetry packages (they are not vendored into the shared zip), so the
  # layer and this env must appear or disappear together, and recon_core.otel_client stays inert when
  # the ARN is empty rather than failing to import.
  #
  # This matters more here than on the worker now. Since async dispatch the dispatcher is what calls
  # InvokeAgentRuntime on the runtime backend, so without it the trace linking a map run to the agent's
  # own spans has no client end at all -- and the failure is silent, exactly like the xray-endpoint gap.
  dispatch_otel_enabled = var.otel_layer_arn != ""
  dispatch_otel_env = local.dispatch_otel_enabled ? {
    AWS_LAMBDA_EXEC_WRAPPER              = "/opt/otel-instrument"
    AGENT_OBSERVABILITY_ENABLED          = "true"
    OTEL_PYTHON_DISTRO                   = "aws_distro"
    OTEL_PYTHON_CONFIGURATOR             = "aws_configurator"
    OTEL_AWS_APPLICATION_SIGNALS_ENABLED = "false"
    OTEL_PROPAGATORS                     = "tracecontext,baggage,xray-lambda,xray"
    OTEL_TRACES_EXPORTER                 = "otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL          = "http/protobuf"
    OTEL_LOGS_EXPORTER                   = "none"
    OTEL_METRICS_EXPORTER                = "none"
    OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS     = var.otel_baggage_span_attribute_keys
    # Safe here for the same reason as on the worker: these Lambdas carry no gen-ai content, so opting
    # out keeps item and case text out of trace payloads at no cost to the online evaluators.
    AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT = "true"
  } : {}

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

  # compact() drops the empty string so a disabled config attaches no layer at all.
  layers = compact([var.otel_layer_arn])

  # Active, not PassThrough: with PassThrough an uninstrumented caller leaves no sampled
  # _X_AMZN_TRACE_ID for the ADOT distro to join, so the spans start their own orphan trace.
  tracing_config {
    mode = local.dispatch_otel_enabled ? "Active" : "PassThrough"
  }
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

  # See terraform_data.iam_propagation: ordering alone is not enough, IAM needs to propagate
  # before Lambda will validate this role for VPC attachment.
  depends_on = [terraform_data.iam_propagation]
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

  # compact() drops the empty string so a disabled config attaches no layer at all.
  layers = compact([var.otel_layer_arn])

  # Active, not PassThrough: with PassThrough an uninstrumented caller leaves no sampled
  # _X_AMZN_TRACE_ID for the ADOT distro to join, so the spans start their own orphan trace.
  tracing_config {
    mode = local.dispatch_otel_enabled ? "Active" : "PassThrough"
  }

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

  # See terraform_data.iam_propagation: ordering alone is not enough, IAM needs to propagate
  # before Lambda will validate this role for VPC attachment.
  depends_on = [terraform_data.iam_propagation]
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

  # compact() drops the empty string so a disabled config attaches no layer at all.
  layers = compact([var.otel_layer_arn])

  # Active, not PassThrough: with PassThrough an uninstrumented caller leaves no sampled
  # _X_AMZN_TRACE_ID for the ADOT distro to join, so the spans start their own orphan trace.
  tracing_config {
    mode = local.dispatch_otel_enabled ? "Active" : "PassThrough"
  }
  timeout     = 30
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

  # See terraform_data.iam_propagation: ordering alone is not enough, IAM needs to propagate
  # before Lambda will validate this role for VPC attachment.
  depends_on = [terraform_data.iam_propagation]
}
