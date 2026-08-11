####################################################################################
# recon-agent-harness module: the managed AgentCore Harness sibling of the container runtime.
# The AWS provider doesn't model Harness, so lifecycle runs through boto3 (manage_harness.py)
# from a terraform_data provisioner; a data "external" reads the ARN back (same out-of-band
# pattern as the gateway/policy CLI shims). Coexists with the runtime — the agent-worker's
# AGENT_BACKEND selects which one serves an item.
####################################################################################

data "aws_caller_identity" "current" {}

locals {
  harness_name = "${replace(var.name_prefix, "-", "_")}_harness"
  skill_uris = [
    for name in var.skill_names :
    "s3://${var.assets_bucket}/${var.skills_prefix}${name}/"
  ]
  # Re-run create/update when any config input changes.
  # Includes harness_config.py: allowedTools/tool-schema/maxIterations are baked into the
  # definition, so a config-only edit must recreate the harness or it is a silent no-op.
  # Includes var.system_prompt (see the hash below): the prompt is baked into the definition, so a
  # prompt-only edit HAS to re-run the provisioner. The cost is that editing the tracked
  # system-prompt.md recreates the harness (new ARN, delete/create race). A prompt edit made
  # through the UI writes only to S3 and correctly recreates nothing — the worker reads that copy
  # fresh and sends it as an InvokeHarness `systemPrompt` override.
  # Harness OTel configuration → the harness definition's `environmentVariables`. Only non-empty
  # values are sent: an absent key means "AgentCore default", whereas an empty string is a real
  # setting (e.g. OTEL_PYTHON_DISABLED_INSTRUMENTATIONS="" would disable nothing explicitly), and
  # the two gen-ai settings must stay ABSENT unless deliberately switched on so the online
  # evaluators keep receiving content records.
  harness_env = merge(
    {
      OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = var.otel_baggage_span_attribute_keys
    },
    var.otel_excluded_urls == "" ? {} : { OTEL_PYTHON_EXCLUDED_URLS = var.otel_excluded_urls },
    var.otel_disabled_instrumentations == "" ? {} : {
      OTEL_PYTHON_DISABLED_INSTRUMENTATIONS = var.otel_disabled_instrumentations
    },
    var.otel_genai_content_extraction_opt_out ? {
      AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT = "true"
    } : {},
    var.otel_semconv_stability_opt_in == "" ? {} : {
      OTEL_SEMCONV_STABILITY_OPT_IN = var.otel_semconv_stability_opt_in
    },
    # Third-party observability: endpoint and headers are only useful together.
    var.otel_exporter_otlp_endpoint == "" || var.otel_exporter_otlp_headers == "" ? {} : {
      OTEL_EXPORTER_OTLP_ENDPOINT = var.otel_exporter_otlp_endpoint
      OTEL_EXPORTER_OTLP_HEADERS  = var.otel_exporter_otlp_headers
    },
  )
  config_hash = sha256(join("|", concat(
    [var.gateway_arn, var.harness_model_id, join(",", local.skill_uris),
      filemd5("${var.harness_config_dir}/harness_config.py"),
      # The system prompt is baked into the harness definition (UpdateHarness systemPrompt), so
      # editing system-prompt.md must re-run the provisioner. Without this, a prompt-only edit
      # was a silent no-op and the live harness kept the prompt it was created with.
      sha256(var.system_prompt),
      # Hashed so editing an OTel variable actually re-runs the provisioner instead of being a
      # silent no-op (the harness definition is only touched when this trigger changes).
      jsonencode(local.harness_env)
    ],
    var.vpc_subnet_ids,
  )))
  env = {
    HARNESS_NAME       = local.harness_name
    HARNESS_CONFIG_DIR = var.harness_config_dir
    EXECUTION_ROLE_ARN = aws_iam_role.harness.arn
    GATEWAY_ARN        = var.gateway_arn
    MODEL_ID           = var.harness_model_id
    SYSTEM_PROMPT      = var.system_prompt
    SKILLS_S3_URIS     = join(",", local.skill_uris)
    SUBNETS            = join(",", var.vpc_subnet_ids)
    SECURITY_GROUPS    = join(",", var.vpc_security_group_ids)
    # One JSON blob because a provisioner environment can only carry flat strings.
    HARNESS_ENV_JSON = jsonencode(local.harness_env)
    AWS_REGION       = var.region
  }
}

# ---------------------------------------------------------------------------------
# Harness execution role
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "harness" {
  name = "${var.name_prefix}-harness-exec"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "bedrock-agentcore.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "harness" {
  name = "${var.name_prefix}-harness-exec-policy"
  role = aws_iam_role.harness.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Invoke the model (base + inference profile).
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        # Call the egress tools gateway (awsIam outbound). Gateway-level authorization.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = var.gateway_arn
      },
      {
        # Read the system prompt + skills from S3 (works via the S3 VPC endpoint, no NAT).
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [var.assets_bucket_arn, "${var.assets_bucket_arn}/*"]
      },
      {
        # Pull the managed harness runtime image + write logs/traces.
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
          # Same span-export set as the container runtime role (infra/modules/recon-agent):
          # the OTLP agent-observability path uses PutSpans/PutSpansForIndexing, and sampling
          # lookups are needed once the harness respects centralized sampling rules.
          "xray:PutTraceSegments", "xray:PutTelemetryRecords",
          "xray:PutSpans", "xray:PutSpansForIndexing",
          "xray:GetSamplingRules", "xray:GetSamplingTargets",
        ]
        Resource = "*"
      },
      {
        # VPC-mode ENI management.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"]
        Resource = "*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------------
# Harness lifecycle (boto3 via manage_harness.py)
# ---------------------------------------------------------------------------------

resource "terraform_data" "harness" {
  triggers_replace = {
    config = local.config_hash
    role   = aws_iam_role.harness.arn
    # Stored so the destroy-time provisioner (which cannot read locals/vars) can tear down.
    harness_name = local.harness_name
    region       = var.region
  }

  provisioner "local-exec" {
    command     = "python3 ${path.module}/manage_harness.py"
    environment = local.env
  }

  # Destroy-time: tear the harness down (best-effort; name+region from stored triggers).
  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    command    = "python3 ${path.module}/manage_harness.py --delete"
    environment = {
      HARNESS_NAME = self.triggers_replace.harness_name
      AWS_REGION   = self.triggers_replace.region
    }
  }

  depends_on = [aws_iam_role_policy.harness]
}

# Read the ARN back (read-only lookup by name). The external data source passes `query` as JSON
# on stdin; manage_harness.py --lookup reads name/region from it. depends_on defers to apply,
# after the harness is created.
data "external" "harness_arn" {
  program = ["python3", "${path.module}/manage_harness.py", "--lookup"]
  query = {
    harness_name = local.harness_name
    region       = var.region
  }
  depends_on = [terraform_data.harness]
}
