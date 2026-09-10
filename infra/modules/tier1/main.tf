####################################################################################
# Tier-1 module: DynamoDB-Streams-triggered deterministic reconciler + async agent worker.
# The stream consumer resolves or escalates each item; escalation async-invokes the
# agent-worker Lambda (off the stream shard) which makes the blocking InvokeAgentRuntime call.
####################################################################################

# The Lambda deployment zip is built once by the shared lambda-package module (root contains
# the backend/ package); passed in via var.lambda_zip / var.lambda_source_hash.

# Only used to pin this module's CloudWatch Logs grants to this account and region — the module
# takes no region/account variable, and inventing one would make every caller pass it.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # Client-side OTel tracing for the agent-worker Lambda. Enabled iff an ADOT layer ARN is given.
  # The layer is what PROVIDES the opentelemetry packages — they are deliberately NOT vendored into
  # the shared Lambda zip — so the layer and this env block must appear or disappear together. An
  # empty ARN yields {}, and the worker's otel_client helpers then stay inert rather than failing to
  # import.
  worker_otel_enabled = var.otel_layer_arn != ""
  worker_otel_env = local.worker_otel_enabled ? {
    # The layer's exec wrapper: runs the handler under `opentelemetry-instrument`, which installs
    # the tracer provider and auto-instruments botocore BEFORE our handler module is imported.
    # Without it the layer is inert and every span is a no-op.
    AWS_LAMBDA_EXEC_WRAPPER = "/opt/otel-instrument"
    # Read by BOTH the ADOT distro and backend/recon_core/otel_client.py — one switch, so the
    # code can never try to import opentelemetry on a function without the layer.
    AGENT_OBSERVABILITY_ENABLED = "true"
    # Select the AWS distro/configurator shipped in the layer (X-Ray OTLP + gen-ai conventions)
    # instead of the upstream OTel defaults.
    OTEL_PYTHON_DISTRO       = "aws_distro"
    OTEL_PYTHON_CONFIGURATOR = "aws_configurator"
    # Application Signals is a different product surface (service maps/SLOs) and would add its own
    # exporter + metrics; agent observability only needs the trace path.
    OTEL_AWS_APPLICATION_SIGNALS_ENABLED = "false"
    # xray-lambda picks up the _X_AMZN_TRACE_ID the Lambda service injects, so our spans join the
    # trace that started upstream; tracecontext+baggage are what we then send onward.
    OTEL_PROPAGATORS            = "tracecontext,baggage,xray-lambda,xray"
    OTEL_TRACES_EXPORTER        = "otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    # Traces only: logs already go to CloudWatch Logs and metrics would add cost for no signal.
    OTEL_LOGS_EXPORTER    = "none"
    OTEL_METRICS_EXPORTER = "none"
    # Keys promoted from W3C baggage onto spans; must match the harness module's copy.
    OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = var.otel_baggage_span_attribute_keys
    # Safe HERE (unlike on the harness): this Lambda emits no gen-ai content, so opting out costs
    # the online evaluators nothing and keeps item/case text out of the trace payloads.
    AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT = "true"
  } : {}
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------------
# Dead-letter queue for poison stream records
# ---------------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name = "${var.name_prefix}-tier1-dlq"
  # Encrypt queued messages at rest with the SQS-managed key (no CMK to provision).
  sqs_managed_sse_enabled = true
}

# ---------------------------------------------------------------------------------
# Async agent-worker Lambda: makes the blocking InvokeAgentRuntime call
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "worker" {
  name               = "${var.name_prefix}-agent-worker"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "worker" {
  name = "${var.name_prefix}-agent-worker-policy"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # VPC-attached Lambda ENI management.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"]
        Resource = "*"
      },
      {
        # Export the worker's own client-side spans. Same action set as the runtime + harness
        # execution roles: PutSpans/PutSpansForIndexing are the OTLP agent-observability path,
        # PutTraceSegments/PutTelemetryRecords the classic X-Ray one. Granted unconditionally —
        # inert when no layer is attached, and it keeps enabling tracing a one-variable change.
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments", "xray:PutTelemetryRecords",
          "xray:PutSpans", "xray:PutSpansForIndexing",
          "xray:GetSamplingRules", "xray:GetSamplingTargets",
        ]
        Resource = "*"
      },

      {
        # InvokeAgentRuntime authorizes against the runtime AND its endpoint sub-resource
        # (…/runtime-endpoint/DEFAULT), so both ARNs are required. Kept even when the ingress
        # path is enabled — the worker falls back to a direct invoke on any ingress failure.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = var.agent_runtime_arn != "" ? [var.agent_runtime_arn, "${var.agent_runtime_arn}/*"] : ["*"]
      },
      # Invoke the agent THROUGH the ingress gateway (preferred path), and — harness backend —
      # execute the Policy-gated set_draw_status write THROUGH the egress tools gateway.
      # Authorization is at the gateway level (not per-target).
      {
        Effect = "Allow"
        Action = ["bedrock-agentcore:InvokeGateway"]
        Resource = compact([
          var.ingress_gateway_arn != "" ? var.ingress_gateway_arn : "*",
          var.egress_gateway_arn != "" ? "${var.egress_gateway_arn}*" : "",
        ])
      },
      # Harness backend (agent_backend="harness"): invoke the managed harness. Despite the API
      # being "InvokeHarness", IAM validates "InvokeAgentRuntime" on the harness ARN (confirmed
      # by the live AccessDenied error). Grant both to be future-safe.
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"]
        Resource = var.harness_arn != "" ? [var.harness_arn, "${var.harness_arn}/*"] : ["*"]
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = compact([
          var.cases_table_arn, "${var.cases_table_arn}/index/*", var.audit_table_arn,
          var.lessons_table_arn != "" ? var.lessons_table_arn : "",
        ])
      },
      {
        # Resolve NOTIFY_CONTACT_ID to an address before the resolution email goes out. GetItem
        # only, on the contacts table only: the worker must never be able to add a recipient, and
        # it has no reason to read the templates table (the notification wording is its own).
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = var.contacts_table_arn != "" ? [var.contacts_table_arn] : ["arn:aws:dynamodb:*:*:table/__none__"]
      },
      {
        # Worker reads auto-resolve threshold, agent-backend selector, and harness-config-version
        # pointer — all SSM params under the platform prefix.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:*:*:parameter/${var.name_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = var.assets_bucket_arn != "" ? [var.assets_bucket_arn, "${var.assets_bucket_arn}/*"] : ["arn:aws:s3:::__none__"]
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:RetrieveMemoryRecords"]
        Resource = var.memory_arn != "" ? [var.memory_arn, "${var.memory_arn}/*"] : ["arn:aws:bedrock-agentcore:*:*:memory/__none__"]
      },
      {
        # Resolve the knowledge-base evidence toggle from the operator's workflow types. Scan, not
        # Query: `active` cannot be indexed (DynamoDB will not key on a BOOLEAN) and the table holds a
        # handful of hand-maintained rows. Read-only, and only on the proposal path.
        Effect   = "Allow"
        Action   = ["dynamodb:Scan"]
        Resource = var.workflow_types_table_arn == "" ? "arn:aws:dynamodb:*:*:table/__none__" : var.workflow_types_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "worker" {
  function_name    = "${var.name_prefix}-agent-worker"
  role             = aws_iam_role.worker.arn
  runtime          = "python3.12"
  handler          = "backend.tier1.agent_worker.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  # ADOT layer: supplies the opentelemetry packages + /opt/otel-instrument. compact() drops the
  # empty string so a disabled config attaches no layer at all.
  layers = compact([var.otel_layer_arn])

  # X-Ray must be Active for the Lambda service to seed a sampled _X_AMZN_TRACE_ID; with
  # PassThrough an uninstrumented caller leaves us with no trace to join.
  tracing_config {
    mode = local.worker_otel_enabled ? "Active" : "PassThrough"
  }

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  # Agent investigations (harness inline round-trip or runtime InvokeAgentRuntime) can run
  # minutes; give the worker headroom regardless of the runtime-switchable backend.
  timeout = 900

  environment {
    # merge(): the OTel block is empty when tracing is disabled, leaving these variables untouched.
    variables = merge({
      # Backend selector: env is the deploy-time seed; AGENT_BACKEND_PARAM (SSM) is the
      # runtime-switchable source of truth (Config tab), read per invocation by the worker.
      AGENT_BACKEND       = var.agent_backend
      AGENT_BACKEND_PARAM = var.agent_backend_param
      # Ingress-gateway invocation path (runtime backend). Falls back to a direct
      # InvokeAgentRuntime when disabled or on any ingress error.
      USE_INGRESS_GATEWAY = var.use_ingress_gateway ? "true" : "false"
      INGRESS_GATEWAY_URL = var.ingress_gateway_url
      INGRESS_TARGET_NAME = var.ingress_target_name
      # Harness backend config (read by backend/harness_agent/worker.py).
      HARNESS_ARN = var.harness_arn
      # Same pairing as AGENT_BACKEND above: the env var is the deploy-time seed, the SSM parameter is
      # the runtime-switchable source of truth (Config tab), read per invocation.
      HARNESS_MODEL_ID  = var.harness_model_id
      AGENT_MODEL_PARAM = var.agent_model_id_param
      # The harness prompt is composed from TWO objects: the shared policy core (same key the
      # runtime container reads, so a backend switch cannot change the agent's instructions) plus
      # this backend's calling contract. See backend/recon_core/prompt_source.py.
      SYSTEM_PROMPT_KEY         = var.system_prompt_key
      HARNESS_SYSTEM_PROMPT_KEY = var.harness_system_prompt_key
      CASES_TABLE               = var.cases_table
      # Resolving whether an operator enabled the knowledge-base route as an evidence source. Read at
      # PROPOSAL time only — never from the gateway interceptor, which sits on every tool call. Empty is
      # a coherent value and resolves to "not enabled", so a missing wiring refuses rather than passes.
      WORKFLOW_TYPES_TABLE         = var.workflow_types_table
      AUDIT_TABLE                  = var.audit_table
      LESSONS_TABLE                = var.lessons_table
      MEMORY_ID                    = var.memory_id
      ASSETS_BUCKET                = var.assets_bucket
      SKILLS_PREFIX                = var.skills_prefix
      AUTO_RESOLVE_PARAM           = var.auto_resolve_param
      HARNESS_CONFIG_VERSION_PARAM = var.harness_config_version_param
      # Harness-backend execute path: the WORKER performs the Policy-gated set_draw_status
      # write through the EGRESS tools gateway and sends the resolution email (the model is
      # propose-only on the harness backend).
      RECON_GATEWAY_URL = var.egress_gateway_url
      GRAPH_MAILBOX     = var.graph_mailbox
      # WHO the resolution email goes to is a contact ID plus the table to look it up in -- never
      # the address itself. backend/cases/notify.py resolves it per send and refuses a deactivated
      # or wrong-kind contact, so an operator revoking a recipient in the Config tab takes effect
      # on the next case instead of at the next deploy.
      NOTIFY_CONTACT_ID = var.notify_contact_id
      CONTACTS_TABLE    = var.contacts_table
      # Human-confirmation token for the auto-resolve resolution email (interceptor gate).
      EMAIL_CONFIRMATION_TOKEN = var.email_confirmation_token
      },
      local.worker_otel_env,
    )
  }
}

# ⚠️ maximum_retry_attempts = 0 is load-bearing. Asynchronous invocations (the Tier-1 consumer calls
# the worker with InvocationType=Event) retry TWICE by default, and that default is actively harmful
# here: a worker error almost always means "the agent invocation did not return in time", not "the
# agent did not run" — the investigation is still executing server-side and writes its own case row.
# Each retry therefore starts a SECOND full LLM investigation of the same item against the same
# session, and they stack. Retrying also cannot help: there is no response left for the worker to
# salvage, so it can only duplicate cost.
resource "aws_lambda_function_event_invoke_config" "worker" {
  function_name          = aws_lambda_function.worker.function_name
  maximum_retry_attempts = 0
  # An investigation can run ~20 minutes; the default 6h event age is irrelevant next to that, but
  # pinning it keeps a queued event from being dispatched long after the case is stale.
  maximum_event_age_in_seconds = 3600
}

# ---------------------------------------------------------------------------------
# Tier-1 stream consumer Lambda
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "tier1" {
  name               = "${var.name_prefix}-tier1"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "tier1" {
  name = "${var.name_prefix}-tier1-policy"
  role = aws_iam_role.tier1.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # VPC-attached Lambda ENI management.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"]
        Resource = "*"
      },

      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords", "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream", "dynamodb:ListStreams",
        ]
        Resource = var.items_stream_arn
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = [
          var.items_table_arn,
          var.cases_table_arn,
          "${var.cases_table_arn}/index/*",
          var.audit_table_arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = compact([aws_lambda_function.worker.arn, var.gl_query_function_arn])
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.dlq.arn
      },
      {
        # Read the deterministic-tier on/off toggle at runtime.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = var.tier1_enabled_param_arn
      },
      {
        # Resolve the knowledge-base evidence toggle from the operator's workflow types. Scan, not
        # Query: `active` cannot be indexed (DynamoDB will not key on a BOOLEAN) and the table holds a
        # handful of hand-maintained rows. Read-only, and only on the proposal path.
        Effect   = "Allow"
        Action   = ["dynamodb:Scan"]
        Resource = var.workflow_types_table_arn == "" ? "arn:aws:dynamodb:*:*:table/__none__" : var.workflow_types_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "tier1" {
  function_name    = "${var.name_prefix}-tier1"
  role             = aws_iam_role.tier1.arn
  runtime          = "python3.12"
  handler          = "backend.tier1.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 60

  environment {
    variables = {
      CASES_TABLE = var.cases_table
      # See the note on the other function: the evidence verdict needs the operator's Config answer.
      WORKFLOW_TYPES_TABLE  = var.workflow_types_table
      AUDIT_TABLE           = var.audit_table
      AGENT_RUNTIME_ARN     = var.agent_runtime_arn
      AGENT_WORKER_FUNCTION = aws_lambda_function.worker.function_name
      TIER1_ENABLED_PARAM   = var.tier1_enabled_param
      GL_QUERY_FUNCTION     = var.gl_query_function_name
    }
  }
}

resource "aws_lambda_event_source_mapping" "stream" {
  event_source_arn               = var.items_stream_arn
  function_name                  = aws_lambda_function.tier1.arn
  starting_position              = "LATEST"
  batch_size                     = 10
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = 3

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.dlq.arn
    }
  }
}
