####################################################################################
# recon-agent-harness module: the managed AgentCore Harness sibling of the container runtime.
# Coexists with the runtime — the agent-worker's AGENT_BACKEND selects which one serves an item.
#
# ⚠️ WHY THERE IS CLOUDFORMATION IN A PURE-TERRAFORM REPO (the other instance is
# modules/recon-agent/kb-connector-target.tf, and the reasoning is the same shape)
#
# `aws_bedrockagentcore_harness` EXISTS as of aws 6.62.0 and is still unusable here. Four fields
# this harness depends on are marked COMPUTED — i.e. readable, not settable:
#
#   * allowed_tools        — the list the service ENFORCES. Losing it offers the model every tool on
#                            the gateway, including the raw Graph ops that are excluded on purpose.
#   * max_iterations       — 20, raised from 12 because skill loads consume turns and real items hit
#                            the cap mid-investigation.
#   * lifecycle_configuration — the short idle/max-lifetime session timeouts.
#   * skill                — takes `path` ONLY, no S3 source. This harness loads skills from S3.
#
# `AWS::BedrockAgentCore::Harness` models all four (FULLY_MUTABLE, HarnessName create-only), so the
# lifecycle runs through a CloudFormation stack. Before "fixing" this by porting to the native
# resource, check whether those four have stopped being computed and whether `skill` gained an `s3`
# block. Until then the port silently deploys a harness with service defaults and an open toolset.
#
# A CloudFormation stack is also the better shape than a provisioner shelling out to boto3, which is
# the other way to reach these fields:
#
#   * The harness ARN and the id of the runtime it materializes are readOnly properties, so they come
#     back as stack Outputs — no read-back shim, and no ListAgentRuntimes pagination to find the
#     harness's log group.
#   * A system-prompt or tool-schema edit is an IN-PLACE UpdateHarness with a stable ARN. Anything
#     that recreated the harness instead would race its own teardown, which in VPC mode can sit in
#     DELETING for ~14 minutes.
#   * The teardown budget is the stack's `timeout_in_minutes` rather than a hand-rolled poll loop.
#
# The apply path is deliberately toolchain-free: no docker, npm, pip or python3 runs during
# `terraform apply`, so a plain runner with only Terraform and AWS credentials can deploy this.
####################################################################################

data "aws_caller_identity" "current" {}

locals {
  harness_name = "${replace(var.name_prefix, "-", "_")}_harness"
  skill_uris = [
    for name in var.skill_names :
    "s3://${var.assets_bucket}/${var.skills_prefix}${name}/"
  ]

  # Tools, allowedTools, maxIterations and the lifecycle timeouts come from the blueprint's
  # harness_config.py, which stays the authored source of truth. HCL cannot import Python, so it
  # reads a DERIVED, committed JSON export instead — keeping the apply free of any interpreter.
  # `python3 infra/scripts/gen_harness_config_json.py` regenerates it, and
  # tests/harness_agent/test_harness_config_json.py fails when it is stale, so a forgotten
  # regeneration cannot reach a deploy silently.
  harness_config = jsondecode(file("${var.harness_config_dir}/harness_config.json"))

  # The gateway ARN is only known at apply time and so cannot be baked into a committed file. The
  # export carries a sentinel; substitute the real ARN through the JSON round-trip so the
  # replacement happens on the serialized form and cannot miss a nested occurrence.
  harness_tools = jsondecode(replace(
    jsonencode(local.harness_config.tools),
    local.harness_config.gateway_arn_sentinel,
    var.gateway_arn,
  ))

  # VPC mode when subnets are supplied, else PUBLIC.
  # Built with merge() rather than a conditional because the two branches are different object
  # TYPES (PUBLIC carries no NetworkModeConfig), and a `? :` requires both results to unify.
  harness_vpc_mode = length(var.vpc_subnet_ids) > 0
  harness_network = merge(
    { NetworkMode = local.harness_vpc_mode ? "VPC" : "PUBLIC" },
    local.harness_vpc_mode ? {
      NetworkModeConfig = {
        Subnets        = var.vpc_subnet_ids
        SecurityGroups = var.vpc_security_group_ids
      }
    } : {},
  )

  # Harness OTel configuration → the harness definition's EnvironmentVariables. Only non-empty
  # values are sent: an absent key means "AgentCore default", whereas an empty string is a real
  # setting (e.g. OTEL_PYTHON_DISABLED_INSTRUMENTATIONS="" would disable nothing explicitly), and
  # the two gen-ai settings must stay ABSENT unless deliberately switched on so the online
  # evaluators keep receiving content records.
  harness_env = merge(
    {
      OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = var.otel_baggage_span_attribute_keys
      # Same unified span destination as the container runtime, so both backends put spans beside
      # their own logs instead of in the shared `aws/spans`. See the runtime module for the three
      # preconditions and for what a missing logs:PutResourcePolicy looks like.
      UNIFIED_TRACES_DESTINATION_ENABLED = "true"
      # Sample every trace, for the same reason as the container runtime: the X-Ray centralized
      # sampler's account Default rule is FixedRate 0.05, and these traces feed online evaluation,
      # which can only score sessions whose spans it can see. See modules/recon-agent for the full
      # account of how a 5% sample presents itself (one platform span, 0 tokens, no gen-ai spans).
      OTEL_TRACES_SAMPLER = "always_on"
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

  harness_properties = merge(
    {
      HarnessName      = local.harness_name
      ExecutionRoleArn = aws_iam_role.harness.arn
      Model            = { BedrockModelConfig = { ModelId = var.harness_model_id } }
      SystemPrompt     = [{ Text = var.system_prompt }]
      Tools            = local.harness_tools
      Skills           = [for uri in local.skill_uris : { S3 = { Uri = uri } }]
      AllowedTools     = local.harness_config.allowed_tools
      Memory           = { Disabled = {} }
      MaxIterations    = local.harness_config.max_iterations
      Environment = {
        AgentCoreRuntimeEnvironment = {
          LifecycleConfiguration = {
            IdleRuntimeSessionTimeout = local.harness_config.idle_runtime_session_timeout
            MaxLifetime               = local.harness_config.max_lifetime
          }
          NetworkConfiguration = local.harness_network
        }
      }
    },
    # Omitted entirely when empty: CreateHarness rejects an empty map, and sending {} on an update
    # would wipe variables someone set out-of-band.
    length(local.harness_env) == 0 ? {} : { EnvironmentVariables = local.harness_env },
  )
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
        # Unified span destination: AgentCore puts a resource policy on the harness's own log group
        # so X-Ray may deliver spans into it. Scoped to this harness's groups, and separate from the
        # broad statement below because that one is on "*" for actions that cannot be scoped -- this
        # one CAN be, so it is. See infra/modules/recon-agent for what a missing grant looks like:
        # the `spans` stream is created, stays empty, and the agent's spans are lost rather than
        # falling back to aws/spans.
        Effect = "Allow"
        Action = ["logs:PutResourcePolicy"]
        Resource = [
          "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/harness_${replace(var.name_prefix, "-", "_")}_harness-*",
          "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/harness_${replace(var.name_prefix, "-", "_")}_harness-*:*",
        ]
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
# Harness lifecycle (AWS::BedrockAgentCore::Harness via CloudFormation)
# ---------------------------------------------------------------------------------

locals {
  harness_template = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "AgentCore Harness for the recon agent (managed by Terraform; see infra/modules/recon-agent-harness)."

    Resources = {
      Harness = {
        Type       = "AWS::BedrockAgentCore::Harness"
        Properties = local.harness_properties
      }
    }

    # Both are readOnlyProperties on the resource type, so GetAtt resolves them and no read-back API
    # call is needed. AgentRuntimeId is nested, hence the dotted attribute path.
    #
    # ⚠️ The runtime id is NOT cosmetic. A harness named <name> runs as an AgentCore runtime whose
    # id suffix is service-generated and changes whenever the harness is recreated, so its log group
    # (/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT) cannot be derived statically. The online
    # evaluation configs need that exact group: the evaluation service reads gen-ai event records
    # ONLY from the log groups named in its data source and never follows the spans'
    # aws.log.group.names pointer.
    Outputs = {
      HarnessArn = {
        Description = "Harness ARN, consumed by the Tier-1 worker."
        Value       = { "Fn::GetAtt" = ["Harness", "Arn"] }
      }
      AgentRuntimeId = {
        Description = "Id of the runtime the harness materializes, for the online-eval log group."
        Value       = { "Fn::GetAtt" = ["Harness", "Environment.AgentCoreRuntimeEnvironment.AgentRuntimeId"] }
      }
    }
  })
}

# The template body, hosted rather than inlined — see template_url below for why.
resource "aws_s3_object" "harness_template" {
  bucket = var.assets_bucket
  # The content hash is IN THE KEY, so a template change produces a new URL and therefore a stack
  # update. Keying on a static name would leave template_url identical across a real change and the
  # stack would silently keep the previous definition.
  key          = "builds/harness-template-${sha256(local.harness_template)}.json"
  content      = local.harness_template
  content_type = "application/json"
}

# ⚠️ HarnessName is the resource type's only create-only property, and a harness cannot be imported
# into a CloudFormation stack. So if a harness named `<prefix>_harness` already exists in the account
# outside this stack, CreateHarness collides on the name and the stack rolls back. Delete it first
# and wait for it to disappear from list-harnesses — a VPC-mode harness can sit in DELETING for ~14
# minutes, and creating alongside a DELETING harness collides just the same:
#
#   aws bedrock-agentcore-control list-harnesses --region <region> \
#     --query "harnesses[?harnessName=='<prefix>_harness'].harnessId" --output text
#   aws bedrock-agentcore-control delete-harness --harness-id <id> --region <region>
#
# The failure mode is loud (stack rollback on a name collision), not silent, and the new ARN reaches
# the Tier-1 worker through this module's outputs, so nothing else needs touching.
resource "aws_cloudformation_stack" "harness" {
  name = "${var.name_prefix}-harness"

  # VPC mode needs BOTH subnets and security groups — CFN's VpcConfig requires each with minItems 1.
  # Checked here rather than left to the API because a missing security group surfaces from
  # CloudFormation as a generic ValidationException on a nested property, several minutes into a
  # rollback.
  lifecycle {
    precondition {
      condition     = length(var.vpc_subnet_ids) == 0 || length(var.vpc_security_group_ids) > 0
      error_message = "vpc_subnet_ids is set but vpc_security_group_ids is empty: a VPC-mode harness requires at least one security group."
    }
  }

  # ⚠️ template_URL, not template_body — and this is not a style choice.
  #
  # CloudFormation's GetTemplate returns non-ASCII mangled: every em dash in the tool descriptions and
  # the system prompt comes back as "?". The stored template and the live harness are both CORRECT
  # (get-harness shows the em dashes intact), but Terraform compares the config's template_body against
  # that mangled read, so it can never match. With template_body that is a PERMANENT diff: UpdateHarness
  # re-runs on every apply and, because four resources depend on the stack's outputs, drags the Tier-1
  # worker, the online-eval config and the frontend task definition into an apply loop that never
  # reaches "No changes".
  #
  # Hosting the template in S3 removes the body from the comparison: Terraform diffs template_url,
  # which carries a content hash, so a REAL template change still updates the stack while a mangled
  # read cannot invent one.
  template_url = "https://${var.assets_bucket}.s3.${var.region}.amazonaws.com/${aws_s3_object.harness_template.key}"

  # A VPC-mode harness has been observed sitting in DELETING for ~14 minutes while its ENIs are
  # torn down — the same lag that affects AgentCore Runtime destroys, so it is a property of the
  # service, not this stack. The default 30 minutes is uncomfortably close to that; 60 leaves room
  # without masking a genuine hang.
  timeout_in_minutes = 60

  depends_on = [aws_iam_role_policy.harness]
}
