####################################################################################
# Recon-agent module: the single Tier-2 agent, batteries included.
# Ships with AgentCore Gateway (Cognito JWT inbound + inference/LLM + IDP targets),
# a fully-managed Bedrock Knowledge Base, and AgentCore Memory. The arm64 container image
# is built by CodeBuild (Terraform is the deploy driver; the AgentCore CLI is NOT used).
####################################################################################

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  image_uri  = "${aws_ecr_repository.agent.repository_url}:latest"

  # IDP MCP client-credentials config (token_url/client_id/client_secret/scope), decoded once
  # here to build the outbound OAuth2 credential provider the gateway target needs to
  # authenticate to IDP's MCP server. The same raw JSON is also stored verbatim in Secrets
  # Manager below for the agent's own direct idp_client.py calls — two independent consumers
  # of one secret.
  idp_mcp_cfg       = var.idp_mcp_secret_json != "" ? jsondecode(var.idp_mcp_secret_json) : null
  idp_provider_name = "${var.name_prefix}-idp-mcp-provider"
  idp_target_name   = "document-extraction"
  # Cognito's real issuer is derived at apply time from a minted token (see
  # null_resource.idp_oauth_provider) — the hosted-UI domain in token_url is NOT the issuer.
  idp_auth_endpoint = local.idp_mcp_cfg != null ? replace(local.idp_mcp_cfg.token_url, "/oauth2/token", "/oauth2/authorize") : ""
  idp_provider_trigger_hash = sha256(join("|", [
    var.idp_gateway_target_url,
    var.idp_mcp_secret_json,
  ]))
}

# ---------------------------------------------------------------------------------
# Container image: ECR + CodeBuild (arm64)
# ---------------------------------------------------------------------------------

resource "aws_ecr_repository" "agent" {
  #checkov:skip=CKV_AWS_136:Repo uses the default AES-256 ECR encryption at rest; a customer-managed KMS key adds key-management overhead not warranted for a demo image repo.
  #checkov:skip=CKV_AWS_51:Mutable tags are required — CodeBuild repeatedly overwrites the ":latest" tag on each demo rebuild; immutable tags would break the build/deploy loop.
  name         = "${var.name_prefix}-agent"
  force_delete = true

  # Scan images for known CVEs on every push (free basic scanning).
  image_scanning_configuration {
    scan_on_push = true
  }
}

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  name               = "${var.name_prefix}-agent-build"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

resource "aws_iam_role_policy" "codebuild" {
  #checkov:skip=CKV_AWS_290:The write action on "*" (ecr:GetAuthorizationToken) cannot be resource-constrained by IAM; remaining writes are scoped to the ECR repo / assets bucket ARNs.
  name = "${var.name_prefix}-agent-build-policy"
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ecr:GetAuthorizationToken does not support resource-level scoping and mandates "*"
        # (it returns an account-wide registry auth token, not a per-repo grant).
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        # Layer-upload / push flow IS resource-scopable — bound to the agent image repo.
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
        ]
        Resource = aws_ecr_repository.agent.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${var.assets_bucket_arn}/*"
      },
    ]
  })
}

resource "aws_codebuild_project" "agent" {
  #checkov:skip=CKV_AWS_316:privileged_mode is required to run the Docker daemon for the container image build; this is the documented CodeBuild pattern for building ARM64 images.
  #checkov:skip=CKV_AWS_314:Build logs stream to the default CodeBuild CloudWatch group; a dedicated logs_config block is unnecessary for a demo build project.
  name         = "${var.name_prefix}-agent-build"
  service_role = aws_iam_role.codebuild.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  # ARM64 build for AgentCore Runtime.
  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/amazonlinux2-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "IMAGE_URI"
      value = local.image_uri
    }
    environment_variable {
      name  = "ASSETS_BUCKET"
      value = var.assets_bucket
    }
  }

  # Build context (agent modules + backend + skills + Dockerfile + buildspec) is staged and
  # uploaded to S3 by build.sh, then consumed here. The buildspec lives at the source root.
  source {
    type      = "S3"
    location  = "${var.assets_bucket}/builds/agent-src.zip"
    buildspec = "buildspec.yml"
  }
}

# ---------------------------------------------------------------------------------
# In-apply image build: stage context -> upload -> start CodeBuild -> WAIT for success.
# This is what makes a single `terraform apply` produce a pushed image before the runtime
# is created. It re-runs whenever the agent source or Dockerfile changes.
# ---------------------------------------------------------------------------------

# Grant CodeBuild read of the uploaded source zip.
resource "aws_iam_role_policy" "codebuild_source" {
  name = "${var.name_prefix}-agent-build-source"
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource = "${var.assets_bucket_arn}/builds/*"
    }]
  })
}

resource "terraform_data" "image_build" {
  # Re-run the build whenever the agent source, skills, Dockerfile, or buildspec change.
  # Hash EVERY *.py in the agent src dir (build.sh stages `*.py`) rather than an explicit
  # per-file list: an explicit list silently goes stale the moment a new module is added
  # (e.g. gateway_mcp.py), and the un-rebuilt image then crashes on a missing import.
  triggers_replace = {
    dockerfile = filemd5("${var.agent_src_dir}/Dockerfile")
    # requirements.txt is staged by build.sh, so a deps-only change (e.g. adding the OTel
    # distro) must rebuild the image too.
    requirements = filemd5("${var.agent_src_dir}/requirements.txt")
    agent_py     = join(",", [for f in fileset(var.agent_src_dir, "*.py") : filemd5("${var.agent_src_dir}/${f}")])
    # The container imports backend.* (recon_core shared domain + harness intake), so a
    # backend-only change must rebuild the image or it ships stale shared logic.
    backend_py   = join(",", [for f in fileset("${var.agent_src_dir}/../../backend", "**/*.py") : filemd5("${var.agent_src_dir}/../../backend/${f}")])
    buildspec    = filemd5("${path.module}/buildspec.yml")
    build_script = filemd5("${path.module}/build.sh")
  }

  provisioner "local-exec" {
    command = "${path.module}/build.sh"
    environment = {
      AGENT_SRC         = var.agent_src_dir
      BACKEND_SRC       = "${var.agent_src_dir}/../../backend"
      IMAGE_URI         = local.image_uri
      ASSETS_BUCKET     = var.assets_bucket
      CODEBUILD_PROJECT = aws_codebuild_project.agent.name
      AWS_REGION        = var.region
    }
  }

  depends_on = [
    aws_codebuild_project.agent,
    aws_iam_role_policy.codebuild,
    aws_iam_role_policy.codebuild_source,
  ]
}

# ---------------------------------------------------------------------------------
# AgentCore Runtime execution role
# ---------------------------------------------------------------------------------

data "aws_iam_policy_document" "agent_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agent" {
  name               = "${var.name_prefix}-agent-runtime"
  assume_role_policy = data.aws_iam_policy_document.agent_assume.json
}

resource "aws_iam_role_policy" "agent" {
  name = "${var.name_prefix}-agent-runtime-policy"
  role = aws_iam_role.agent.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # VPC-mode AgentCore Runtime ENI management.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"]
        Resource = "*"
      },

      {
        # Pull the agent container image from ECR (required to create the AgentCore Runtime).
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.agent.arn
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = [var.cases_table_arn, "${var.cases_table_arn}/index/*", var.audit_table_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"]
        Resource = "*"
      },
      {
        # All tools are invoked THROUGH the egress gateway (MCP), so the runtime needs
        # gateway-invoke on it. AgentCore Policy on the gateway then gates set_draw_status on
        # context.input.confidence. (No direct lambda:InvokeFunction on the tools — routing
        # around the gateway would bypass the policy engine.)
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = "${aws_bedrockagentcore_gateway.this.gateway_arn}*"
      },
      {
        # Recall consolidated analyst lessons (lessons_learned strategy) before classifying.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:ListMemoryRecords"]
        Resource = [aws_bedrockagentcore_memory.this.arn, "${aws_bedrockagentcore_memory.this.arn}/*"]
      },
      {
        # Auto-resolve: read the admin threshold set in the Config tab.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = var.auto_resolve_param_arn
      },
      {
        # Auto-resolve writes an AUTO_RESOLVED lesson to the ledger.
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = var.lessons_table_arn
      },
      {
        # Live skills catalog + system prompt read at runtime from the assets bucket.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${var.assets_bucket_arn}/skills/*", "${var.assets_bucket_arn}/system-prompt.md"]
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = var.assets_bucket_arn
        Condition = { StringLike = { "s3:prefix" = ["skills/*"] } }
      },
      {
        # Read the IDP MCP client-credentials secret to mint the pull-path bearer token.
        # Guarded resource so the policy is valid when the secret is absent.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.idp_mcp_secret_json != "" ? aws_secretsmanager_secret.idp_mcp[0].arn : "arn:aws:secretsmanager:*:*:secret:${var.name_prefix}-idp-mcp-*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
      {
        # ADOT in the container exports spans to the X-Ray OTLP endpoint with SigV4 (this
        # execution role). Without these actions every span export fails silently and the
        # online evaluators see no gen-ai spans in aws/spans. None of the X-Ray write/sampling
        # actions support resource-level scoping.
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments", "xray:PutTelemetryRecords",
          "xray:PutSpans", "xray:PutSpansForIndexing",
          "xray:GetSamplingRules", "xray:GetSamplingTargets",
        ]
        Resource = "*"
      },
      {
        # ADOT also publishes agent runtime metrics.
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "bedrock-agentcore" } }
      },
    ]
  })
}

# ---------------------------------------------------------------------------------
# AgentCore Memory
# ---------------------------------------------------------------------------------

resource "aws_bedrockagentcore_memory" "this" {
  name                  = "${replace(var.name_prefix, "-", "_")}_memory"
  event_expiry_duration = 30 # days
  # AWS stores the strategy's execution role on the parent Memory resource too — must be
  # declared here as well, or every plan wants to null it back out (permanent drift).
  memory_execution_role_arn = aws_iam_role.memory.arn
}

# Execution role AgentCore Memory assumes to run the extraction/consolidation LLM passes for the
# lessons-learned strategy below.
resource "aws_iam_role" "memory" {
  name = "${var.name_prefix}-memory"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "memory" {
  name = "${var.name_prefix}-memory-policy"
  role = aws_iam_role.memory.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      # bedrock:InvokeModel targets runtime-selectable foundation models / cross-region
      # inference profiles (chosen via the Config tab); scoped to every foundation-model and
      # this account's inference-profile ARNs (not fixed model ids) so model switching still works.
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/*",
      ]
    }]
  })
}

# Lessons-learned semantic strategy. Captures how analysts decided to proceed
# (approvals, and disapprovals with correction comments) as consolidated, retrievable memories so
# future reconciliations of similar items are informed by prior corrections. The recon agent
# writes these as memory events under the reconciliation/lessons/{domain} namespace and retrieves
# them during classification/investigation.
resource "aws_bedrockagentcore_memory_strategy" "lessons" {
  memory_id                 = aws_bedrockagentcore_memory.this.id
  name                      = "lessons_learned"
  type                      = "SEMANTIC"
  namespaces                = ["reconciliation/lessons/{actorId}"]
  memory_execution_role_arn = aws_iam_role.memory.arn
  description               = "Lessons captured from analyst approve/disapprove decisions and correction comments."
}

# ---------------------------------------------------------------------------------
# AgentCore Runtime (HTTP protocol, arm64 container)
# ---------------------------------------------------------------------------------

resource "aws_bedrockagentcore_agent_runtime" "this" {
  agent_runtime_name = "${replace(var.name_prefix, "-", "_")}_agent"
  role_arn           = aws_iam_role.agent.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = local.image_uri
    }
  }

  network_configuration {
    network_mode = length(var.vpc_subnet_ids) > 0 ? "VPC" : "PUBLIC"

    dynamic "network_mode_config" {
      for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
      content {
        subnets         = var.vpc_subnet_ids
        security_groups = var.vpc_security_group_ids
        # require_service_s3_endpoint is computed (read-only) — the S3 gateway endpoint on the
        # private route table already keeps S3 traffic on PrivateLink.
      }
    }
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  environment_variables = {
    MEMORY_ID   = aws_bedrockagentcore_memory.this.id
    KB_ID       = aws_bedrockagent_knowledge_base.this.id
    CASES_TABLE = var.cases_table
    AUDIT_TABLE = var.audit_table
    SKILLS_DIR  = "/app/skills"
    # Promote the worker's W3C baggage onto this runtime's spans (same allow-list as the Lambda and
    # the harness). Verified 2026-08-04: the baggage header propagates and the trace links either
    # way, but without this the recon.* keys are absent from the container's spans.
    OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = var.otel_baggage_span_attribute_keys
    # Token for the PLATFORM resolution-email path (notify.py on the auto-resolve branch). The
    # model never reads env — its counterparty-email tool call carries no token and is blocked
    # by the interceptor. Only platform code (notify.py) injects it from here.
    EMAIL_CONFIRMATION_TOKEN = var.email_confirmation_token
    IDP_MCP_SECRET_ARN       = var.idp_mcp_secret_json != "" ? aws_secretsmanager_secret.idp_mcp[0].arn : ""
    IDP_MCP_ENDPOINT         = var.idp_gateway_target_url # the IDP MCP URL for pull_idp_results
    # Live S3 skills + system prompt (editable via the UI, ~60s TTL) and the model the
    # classify/investigate loop calls via the converse API.
    ASSETS_BUCKET     = var.assets_bucket
    SKILLS_PREFIX     = "skills/"
    SYSTEM_PROMPT_KEY = "system-prompt.md"
    MODEL_ID          = var.model_id
    # Straight-through processing: composite confidence >= this SSM threshold -> auto-resolve.
    AUTO_RESOLVE_PARAM = var.auto_resolve_param
    LESSONS_TABLE      = var.lessons_table
    # Auto-resolve notification recipient; the mail is sent FROM the shared mailbox
    # (GRAPH_MAILBOX) via the microsoft-graph gateway tool — no SES.
    RECON_NOTIFY_EMAIL = var.notify_email
    # Shared mailbox the Microsoft Graph email ops send from / read (passed as
    # mailboxAddress to the microsoft-graph OpenAPI ops sendSharedMailboxMail / listSharedMailboxMessages).
    GRAPH_MAILBOX = var.graph_mailbox
    # All tools are called THROUGH the egress gateway (MCP + SigV4) so AgentCore Policy gates
    # them — the runtime signs with its execution role against this gateway URL.
    RECON_GATEWAY_URL = aws_bedrockagentcore_gateway.this.gateway_url
    # container_uri is pinned to :latest, so a rebuilt image does NOT change any tracked runtime
    # attribute — Terraform would skip UpdateAgentRuntime and the runtime would keep its old
    # pinned digest. Bind a benign env var to the build id: every image rebuild changes this,
    # forcing an in-place runtime update that re-pulls the fresh :latest. (App ignores it.)
    IMAGE_BUILD_ID = terraform_data.image_build.id
  }

  # The image must be BUILT AND PUSHED before the runtime can reference it — depend on the
  # build driver (which blocks until CodeBuild succeeds), not merely on the project existing.
  depends_on = [terraform_data.image_build, aws_iam_role_policy.agent]
}

# ---------------------------------------------------------------------------------
# AgentCore Gateway (Cognito JWT inbound)
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "gateway" {
  name               = "${var.name_prefix}-gateway"
  assume_role_policy = data.aws_iam_policy_document.agent_assume.json
}

resource "aws_bedrockagentcore_gateway" "this" {
  # CreateGateway calls GetPolicyEngine with the gateway role, so that grant must already be
  # attached. See the comment on aws_iam_role_policy.gateway_policy_engine for why this cannot
  # be the (lambda-ARN-scoped, gateway-dependent) gateway_tools policy.
  depends_on = [aws_iam_role_policy.gateway_policy_engine]

  # Gateway name must match ^([0-9a-zA-Z][-]?){1,100}$ — hyphens allowed, underscores not.
  name     = "${var.name_prefix}-gateway"
  role_arn = aws_iam_role.gateway.arn
  # EGRESS tools gateway: inbound is AWS_IAM (SigV4). Only the recon Agent Runtime calls it,
  # signing with its execution role — no Cognito client/secret to mint. (Was CUSTOM_JWT; the
  # audit found no live JWT caller of the tools gateway.)
  authorizer_type = "AWS_IAM"

  # DEBUG surfaces the real downstream error in tool responses (dev) — the default sanitizes
  # everything to "An internal error occurred", which hides e.g. OAuth/OpenAPI target faults.
  exception_level = "DEBUG"

  protocol_configuration {
    mcp {
      supported_versions = ["2025-03-26"]
    }
  }

  # REQUEST interceptor: the gateway-layer trust boundary. Enforces set_draw_status
  # provenance and recon_update_status transition legality (DynamoDB lookups Cedar cannot
  # do); every other tool call passes through with zero added I/O. Rollout is mode-gated via
  # the interceptor Lambda's INTERCEPTOR_MODE env (log -> enforce), NOT by removing this block.
  interceptor_configuration {
    interception_points = ["REQUEST"]
    interceptor {
      lambda {
        arn = aws_lambda_function.gateway_interceptor.arn
      }
    }
    input_configuration {
      # Headers can carry credentials; the guard needs only the JSON-RPC body.
      pass_request_headers = false
    }
  }

  # Cedar Policy engine attached natively (was a null_resource + update-gateway CLI step).
  policy_engine_configuration {
    arn  = aws_bedrockagentcore_policy_engine.this.policy_engine_arn
    mode = var.policy_enforcement_mode
  }
}

# ---------------------------------------------------------------------------------
# Gateway REQUEST interceptor Lambda (backend/gateway_interceptor/handler.py): provenance for
# the ledger write + state-machine re-check for the workflow-status tool, at the gateway.
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "gateway_interceptor" {
  name = "${var.name_prefix}-gw-interceptor"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "gateway_interceptor" {
  name = "${var.name_prefix}-gw-interceptor-policy"
  role = aws_iam_role.gateway_interceptor.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (all Describe
        # calls are account-wide), so it must stay on "*".
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        # VPC-attached Lambda ENI mutation IS resource-scopable — bound to this account/region.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${var.region}:${local.account_id}:*"
      },
      {
        # Read-only: persisted proposed_action (provenance) + current status (transitions).
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = var.cases_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "gateway_interceptor" {
  function_name    = "${var.name_prefix}-gw-interceptor"
  role             = aws_iam_role.gateway_interceptor.arn
  runtime          = "python3.12"
  handler          = "backend.gateway_interceptor.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  # The interceptor is on EVERY gateway call's critical path — keep it snappy.
  timeout = 10

  environment {
    variables = {
      CASES_TABLE      = var.cases_table
      INTERCEPTOR_MODE = var.interceptor_mode
      # Email human-confirmation gate: the interceptor allows sendSharedMailboxMail only when the
      # call carries this token (provisioned to the human-driven send paths, NOT the agent
      # runtime), then strips it before forwarding to Graph.
      EMAIL_CONFIRMATION_TOKEN = var.email_confirmation_token
      # A `notification` send may only go to the operator's own address. Compared here rather than
      # looked up, so that branch adds no I/O on the critical path.
      RECON_NOTIFY_EMAIL = var.notify_email
      # A `counterparty` send must additionally be addressed into one of these domains. Checked
      # independently of the approved draft: the persisted recipient could predate a narrowing of
      # this list, so the allowlist has to be the operator's live answer, not a historical one.
      COUNTERPARTY_EMAIL_DOMAINS = join(",", var.counterparty_email_domains)
    }
  }
}

# The gateway's execution role invokes the interceptor on every request.
resource "aws_iam_role_policy" "gateway_interceptor_invoke" {
  name = "${var.name_prefix}-gw-interceptor-invoke"
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.gateway_interceptor.arn
    }]
  })
}

# IDP (document-extraction) Gateway target — only when an endpoint is provided. Described by
# function; the endpoint is a per-deployment variable so no vendor specifics are baked in.
# IDP MCP client-credentials config, stored for the agent to mint its bearer token. This is the
# entire coupling surface to IDP (no bucket/table ARNs). Guarded so it's a no-op when unset.
resource "aws_secretsmanager_secret" "idp_mcp" {
  #checkov:skip=CKV_AWS_149:Encrypted at rest with the AWS-managed Secrets Manager key; a customer-managed CMK adds key-management overhead not warranted for a demo integration config.
  #checkov:skip=CKV2_AWS_57:Automatic rotation is not applicable — this holds static IDP client-credentials config, not a rotatable database/service credential.
  count = var.idp_mcp_secret_json != "" ? 1 : 0
  name  = "${var.name_prefix}-idp-mcp"
}

resource "aws_secretsmanager_secret_version" "idp_mcp" {
  count         = var.idp_mcp_secret_json != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.idp_mcp[0].id
  secret_string = var.idp_mcp_secret_json
}

# mcpServer targets only support OAuth-CC/none outbound auth (never IAM), and creating a
# target triggers an implicit synchronization (tools/list) that fails immediately without
# working credentials — so the target must be created WITH its credential config in the same
# call. The hashicorp/aws provider's aws_bedrockagentcore_gateway_target doesn't expose
# credential_provider_configurations, so this — like microsoft-graph-obo — uses null_resource
# + the AWS CLI, which does accept it.
resource "null_resource" "idp_oauth_provider" {
  count = var.idp_gateway_target_url != "" && var.idp_mcp_secret_json != "" ? 1 : 0

  triggers = {
    provider_name = local.idp_provider_name
    aws_region    = var.region
    config_hash   = local.idp_provider_trigger_hash
  }

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      set -euo pipefail
      NAME='${local.idp_provider_name}'
      REGION='${var.region}'
      TOKEN_URL='${local.idp_mcp_cfg.token_url}'
      CLIENT_ID='${local.idp_mcp_cfg.client_id}'
      CLIENT_SECRET='${local.idp_mcp_cfg.client_secret}'
      AUTH_ENDPOINT='${local.idp_auth_endpoint}'

      # Cognito's token issuer (iss claim) is the cognito-idp form
      # (https://cognito-idp.<region>.amazonaws.com/<poolId>), which is DIFFERENT from the
      # hosted-UI domain that serves the token endpoint. AgentCore validates the minted
      # token's iss against the issuer declared here, so it must be the real one — mint a
      # token now and decode its iss claim rather than guessing from the hosted-UI domain.
      ACCESS_TOKEN=$(curl -sf -X POST "$TOKEN_URL" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&scope=${local.idp_mcp_cfg.scope}" \
        | jq -r '.access_token')
      JWT_PAYLOAD=$(echo "$ACCESS_TOKEN" | cut -d. -f2 | tr '_-' '/+')
      case $(( $${#JWT_PAYLOAD} % 4 )) in
        2) JWT_PAYLOAD="$JWT_PAYLOAD==" ;;
        3) JWT_PAYLOAD="$JWT_PAYLOAD=" ;;
      esac
      ISSUER=$(echo "$JWT_PAYLOAD" | base64 -d 2>/dev/null | jq -r '.iss')

      CONFIG=$(jq -nc \
        --arg client_id "$CLIENT_ID" \
        --arg client_secret "$CLIENT_SECRET" \
        --arg issuer "$ISSUER" \
        --arg auth_endpoint "$AUTH_ENDPOINT" \
        --arg token_endpoint "$TOKEN_URL" \
        '{customOauth2ProviderConfig: {
          clientId: $client_id,
          clientSecret: $client_secret,
          oauthDiscovery: {
            authorizationServerMetadata: {
              issuer: $issuer,
              authorizationEndpoint: $auth_endpoint,
              tokenEndpoint: $token_endpoint
            }
          }
        }}')

      if aws bedrock-agentcore-control get-oauth2-credential-provider \
            --name "$NAME" --region "$REGION" >/dev/null 2>&1; then
        echo "[recon-agent] IDP oauth provider exists; updating $NAME" >&2
        aws bedrock-agentcore-control update-oauth2-credential-provider \
          --name "$NAME" \
          --region "$REGION" \
          --credential-provider-vendor CustomOauth2 \
          --oauth2-provider-config-input "$CONFIG" >/dev/null
      else
        echo "[recon-agent] creating IDP oauth provider $NAME" >&2
        aws bedrock-agentcore-control create-oauth2-credential-provider \
          --name "$NAME" \
          --region "$REGION" \
          --credential-provider-vendor CustomOauth2 \
          --oauth2-provider-config-input "$CONFIG" >/dev/null
      fi
    EOT
  }

  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    command    = <<-EOT
      set -euo pipefail
      aws bedrock-agentcore-control delete-oauth2-credential-provider \
        --name '${self.triggers.provider_name}' \
        --region '${self.triggers.aws_region}' >/dev/null 2>&1 || true
    EOT
  }
}

data "external" "idp_oauth_provider_info" {
  count      = var.idp_gateway_target_url != "" && var.idp_mcp_secret_json != "" ? 1 : 0
  depends_on = [null_resource.idp_oauth_provider]

  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    out=$(aws bedrock-agentcore-control get-oauth2-credential-provider \
            --name '${local.idp_provider_name}' \
            --region '${var.region}')
    arn=$(echo "$out" | jq -r '.credentialProviderArn // empty')
    jq -nc --arg arn "$arn" '{provider_arn:$arn}'
  EOT
  ]
}

resource "null_resource" "idp_gateway_target" {
  count = var.idp_gateway_target_url != "" && var.idp_mcp_secret_json != "" ? 1 : 0

  triggers = {
    target_name        = local.idp_target_name
    gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
    aws_region         = var.region
    config_hash        = sha256(join("|", [var.idp_gateway_target_url, local.idp_mcp_cfg.scope]))
  }

  depends_on = [
    null_resource.idp_oauth_provider,
    data.external.idp_oauth_provider_info,
  ]

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      set -euo pipefail
      NAME='${local.idp_target_name}'
      GW='${aws_bedrockagentcore_gateway.this.gateway_id}'
      REGION='${var.region}'
      PROVIDER_ARN='${try(data.external.idp_oauth_provider_info[0].result.provider_arn, "")}'

      if [ -z "$PROVIDER_ARN" ]; then
        echo "[recon-agent] ERROR: IDP oauth provider ARN not found" >&2
        exit 1
      fi

      TARGET_CFG=$(jq -nc --arg ep '${var.idp_gateway_target_url}' '{mcp:{mcpServer:{endpoint:$ep}}}')
      CRED_CFG=$(jq -nc --arg arn "$PROVIDER_ARN" --arg scope '${local.idp_mcp_cfg.scope}' '[
        {
          credentialProviderType: "OAUTH",
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn: $arn,
              scopes: [$scope],
              grantType: "CLIENT_CREDENTIALS"
            }
          }
        }
      ]')

      EXISTING=$(aws bedrock-agentcore-control list-gateway-targets \
        --gateway-identifier "$GW" --region "$REGION" \
        --query "items[?name=='$NAME'].targetId" --output text 2>/dev/null || true)

      if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
        echo "[recon-agent] IDP target exists ($EXISTING); updating" >&2
        aws bedrock-agentcore-control update-gateway-target \
          --gateway-identifier "$GW" \
          --target-id "$EXISTING" \
          --name "$NAME" \
          --region "$REGION" \
          --target-configuration "$TARGET_CFG" \
          --credential-provider-configurations "$CRED_CFG" >/dev/null
      else
        echo "[recon-agent] creating IDP target $NAME" >&2
        aws bedrock-agentcore-control create-gateway-target \
          --gateway-identifier "$GW" \
          --name "$NAME" \
          --description "IDP document-extraction get_results(documentId) via MCP" \
          --region "$REGION" \
          --target-configuration "$TARGET_CFG" \
          --credential-provider-configurations "$CRED_CFG" >/dev/null
      fi
    EOT
  }

  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    command    = <<-EOT
      set -euo pipefail
      GW='${self.triggers.gateway_identifier}'
      NAME='${self.triggers.target_name}'
      REGION='${self.triggers.aws_region}'
      TID=$(aws bedrock-agentcore-control list-gateway-targets \
              --gateway-identifier "$GW" --region "$REGION" \
              --query "items[?name=='$NAME'].targetId" --output text 2>/dev/null || true)
      if [ -n "$TID" ] && [ "$TID" != "None" ]; then
        aws bedrock-agentcore-control delete-gateway-target \
          --gateway-identifier "$GW" \
          --target-id "$TID" \
          --region "$REGION" >/dev/null 2>&1 || true
      fi
    EOT
  }
}

# ---------------------------------------------------------------------------------
# Fully-managed Bedrock Knowledge Base (S3 vectors) + S3 data source
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "kb" {
  name               = "${var.name_prefix}-kb"
  assume_role_policy = data.aws_iam_policy_document.kb_assume.json
}

data "aws_iam_policy_document" "kb_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
  }
}

resource "aws_s3vectors_vector_bucket" "kb" {
  vector_bucket_name = "${var.name_prefix}-kb-vectors"
}

resource "aws_s3vectors_index" "kb" {
  vector_bucket_name = aws_s3vectors_vector_bucket.kb.vector_bucket_name
  index_name         = "${var.name_prefix}-kb-index"
  data_type          = "float32"
  dimension          = 1024
  distance_metric    = "cosine"
}

# KB role needs: query/write the S3 vectors index, read the S3 data source, invoke the
# embedding model. Without this the CreateKnowledgeBase validation probe (s3vectors:QueryVectors)
# fails with 403.
resource "aws_iam_role_policy" "kb" {
  name = "${var.name_prefix}-kb-policy"
  role = aws_iam_role.kb.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3vectors:QueryVectors", "s3vectors:PutVectors", "s3vectors:GetVectors",
          "s3vectors:ListVectors", "s3vectors:DeleteVectors", "s3vectors:GetIndex",
          "s3vectors:GetVectorBucket",
        ]
        Resource = [
          aws_s3vectors_vector_bucket.kb.vector_bucket_arn,
          "${aws_s3vectors_vector_bucket.kb.vector_bucket_arn}/*",
          aws_s3vectors_index.kb.index_arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = "arn:aws:bedrock:${var.region}::foundation-model/amazon.titan-embed-text-v2:0"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [var.assets_bucket_arn, "${var.assets_bucket_arn}/*"]
      },
    ]
  })
}

resource "aws_bedrockagent_knowledge_base" "this" {
  name     = "${var.name_prefix}-kb"
  role_arn = aws_iam_role.kb.arn

  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = "arn:aws:bedrock:${var.region}::foundation-model/amazon.titan-embed-text-v2:0"
    }
  }

  storage_configuration {
    type = "S3_VECTORS"
    s3_vectors_configuration {
      index_arn = aws_s3vectors_index.kb.index_arn
    }
  }

  # The role's s3vectors/embedding policy must be attached before CreateKnowledgeBase runs
  # its validation probe (s3vectors:QueryVectors).
  depends_on = [aws_iam_role_policy.kb]
}

# KB S3 data source: the assets bucket's knowledge-base/ prefix holds the seed corpus.
resource "aws_bedrockagent_data_source" "kb" {
  name              = "${var.name_prefix}-kb-seed"
  knowledge_base_id = aws_bedrockagent_knowledge_base.this.id

  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn         = var.assets_bucket_arn
      inclusion_prefixes = ["knowledge-base/"]
    }
  }
}

# ---------------------------------------------------------------------------------
# Gateway Lambda tools: knowledge-base (Bedrock KB Retrieve) + general-ledger (Athena)
# ---------------------------------------------------------------------------------

# kb-search Lambda — wraps bedrock KB Retrieve; the `knowledge-base` Gateway tool.
resource "aws_iam_role" "kb_search" {
  name = "${var.name_prefix}-kb-search"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "kb_search" {
  name = "${var.name_prefix}-kb-search-policy"
  role = aws_iam_role.kb_search.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (all Describe
        # calls are account-wide), so it must stay on "*".
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        # VPC-attached Lambda ENI mutation IS resource-scopable — bound to this account/region.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${var.region}:${local.account_id}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:Retrieve"]
        Resource = aws_bedrockagent_knowledge_base.this.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "kb_search" {
  function_name    = "${var.name_prefix}-kb-search"
  role             = aws_iam_role.kb_search.arn
  runtime          = "python3.12"
  handler          = "backend.kb_tool.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 15

  environment {
    variables = { KB_ID = aws_bedrockagent_knowledge_base.this.id }
  }
}

# ---------------------------------------------------------------------------------
# email tools are NOT purpose-built Lambdas: the agent sends mail + reads the shared mailbox
# THROUGH the existing microsoft-graph OpenAPI gateway target (module.microsoft_graph). No
# recon-owned Graph secret / Lambda / gateway target — the Graph OpenAPI target owns those creds.
# The shared mailbox SMTP address the ops send from / read is injected as GRAPH_MAILBOX on the
# runtime container (see environment_variables above) and passed by the read tool as
# mailboxAddress. The resolution email (backend/cases/notify.py) rides the same target.
# ---------------------------------------------------------------------------------

# The Gateway invokes tool Lambdas with ITS OWN role (gateway_iam_role credentials).
resource "aws_iam_role_policy" "gateway_tools" {
  name = "${var.name_prefix}-gateway-tools"
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = compact([aws_lambda_function.kb_search.arn, aws_lambda_function.recon_status.arn, aws_lambda_function.correspondence_search.arn, var.gl_tool_lambda_arn, var.set_draw_status_lambda_arn])
      },
      {
        # Outbound OAuth for credential-provider targets (microsoft-graph OpenAPI): the
        # gateway exchanges its workload identity for the target's client-credentials token
        # from the Identity token vault. Without these the target fails every call with
        # "Failed to fetch outbound oauth token ... not authorized to perform
        # bedrock-agentcore:GetWorkloadAccessToken" (observed live 2026-07-26 via
        # exception_level=DEBUG — the default error is a sanitized "internal error").
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetResourceOauth2Token",
        ]
        Resource = [
          "arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:workload-identity-directory/default",
          "arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:workload-identity-directory/default/*",
          "arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:token-vault/default",
          "arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:token-vault/default/*",
        ]
      },
      {
        # The Identity token vault stores provider client secrets in Secrets Manager under
        # the service-managed "bedrock-agentcore-identity!" prefix; the gateway reads them
        # when minting outbound tokens.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:bedrock-agentcore-identity!default/oauth2/*"
      },
    ]
  })
}

# The policy-engine grants live in their OWN inline policy, deliberately separate from
# `gateway_tools` above, because CreateGateway itself calls GetPolicyEngine with this role and
# fails if the grant is not already attached. `gateway_tools` cannot satisfy that: it scopes
# lambda:InvokeFunction to concrete target ARNs, one of which is the correspondence_search
# Lambda, whose env needs `gateway_url` — so gateway_tools transitively DEPENDS ON the gateway
# and is necessarily created after it. Terraform sees no cycle (the gateway never references
# gateway_tools), so it legitimately ordered gateway-before-policy and CreateGateway failed with
# "Access denied while calling GetPolicyEngine on Policy Engine ... with Gateway role" — a
# from-scratch-only failure, invisible on incremental applies where the policy already exists
# (observed live on the 2026-08-08 rebuild). This split holds no resource references at all, so
# the gateway can depends_on it without forming a cycle.
resource "aws_iam_role_policy" "gateway_policy_engine" {
  name = "${var.name_prefix}-gateway-policy-engine"
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The gateway enforces the attached AgentCore Policy engine: its role reads the engine
        # + its policies...
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetPolicyEngine", "bedrock-agentcore:GetPolicy", "bedrock-agentcore:ListPolicies"]
        Resource = "arn:aws:bedrock-agentcore:*:*:policy-engine/*"
      },
      {
        # ...and evaluates policies via the Authorize* family (AuthorizeAction +
        # PartiallyAuthorizeActions), checked against BOTH the policy-engine and gateway
        # resources at attach + request time. Wildcard covers the whole family in one grant.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:*Authorize*"]
        Resource = ["arn:aws:bedrock-agentcore:*:*:policy-engine/*", "arn:aws:bedrock-agentcore:*:*:gateway/*"]
      },
    ]
  })
}

# `knowledge-base` target: search the fully managed Bedrock KB (reconciliation guidance).
resource "aws_bedrockagentcore_gateway_target" "knowledge_base" {
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "knowledge-base"
  description        = "Reconciliation guidance from the fully managed Bedrock Knowledge Base"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.kb_search.arn
        tool_schema {
          inline_payload {
            name        = "search_guidance"
            description = "Search the reconciliation guidance knowledge base for playbooks and resolution patterns relevant to a break."
            input_schema {
              type = "object"
              property {
                name        = "query"
                type        = "string"
                description = "What to look up (break pattern, resolution question)."
                required    = true
              }
              property {
                name        = "top_k"
                type        = "integer"
                description = "Number of passages to return (1-10, default 5)."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # AgentCore itself adds `metadata_configuration.allowed_request_headers =
    # ["x-amzn-bedrock-agentcore-policy-session-id"]` to every target of a policy-enabled
    # gateway (it carries the Cedar session id), and the block CANNOT be declared here: the
    # provider rejects any `X-Amzn-`-prefixed header. Without this ignore, Terraform plans the
    # block's removal on every run and the service re-adds it, forever.
    # Note this does not cover a target's CREATE, where the provider still errors
    # with "block count changed from 0 to 1" — the target is created and recorded in state, but
    # ends up tainted and needs `terraform untaint`.
    ignore_changes = [metadata_configuration]
  }
}

# `general-ledger` target: bounded Athena queries over the mocked GL in S3.
resource "aws_bedrockagentcore_gateway_target" "general_ledger" {
  count              = var.gl_tool_enabled ? 1 : 0
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "general-ledger"
  description        = "General ledger (mock: Amazon S3 + Athena) — search postings by reference, borrower, facility, amount range, or value-date window"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = var.gl_tool_lambda_arn
        tool_schema {
          inline_payload {
            name        = "search_ledger"
            description = "Search general-ledger entries. Filter by document reference, borrower, facility, amount range, or value-date window; results are LIMIT-bounded."
            input_schema {
              type = "object"
              property {
                name        = "reference"
                type        = "string"
                description = "Document reference / id the posting settles."
              }
              property {
                name        = "borrower"
                type        = "string"
                description = "Borrower name (substring match)."
              }
              property {
                name        = "facility"
                type        = "string"
                description = "Facility name (substring match)."
              }
              property {
                name        = "min_amount"
                type        = "number"
                description = "Minimum amount."
              }
              property {
                name        = "max_amount"
                type        = "number"
                description = "Maximum amount."
              }
              property {
                name        = "date_from"
                type        = "string"
                description = "Earliest value date (YYYY-MM-DD)."
              }
              property {
                name        = "date_to"
                type        = "string"
                description = "Latest value date (YYYY-MM-DD)."
              }
              property {
                name        = "limit"
                type        = "integer"
                description = "Max rows (default 25, cap 100)."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the knowledge_base target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# `set-draw-status` write target: the agent (autonomous, when confident) and the human-approve
# path perform the resolution by calling this. The Gateway invokes it with its own IAM role.
resource "aws_bedrockagentcore_gateway_target" "set_draw_status" {
  count              = var.set_draw_status_enabled ? 1 : 0
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "set-draw-status"
  description        = "Record a draw/ledger status change (Cancelled/Confirmed/OnHold/Amended) against the mocked general ledger. Idempotent by reference."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = var.set_draw_status_lambda_arn
        tool_schema {
          inline_payload {
            name        = "set_draw_status"
            description = "Set a draw/ledger posting's status. Use ONLY the reference returned by search_ledger. status must be one of Cancelled, Confirmed, OnHold, Amended."
            input_schema {
              type = "object"
              property {
                name        = "reference"
                type        = "string"
                description = "The exact ledger reference to update (from a search_ledger result)."
              }
              property {
                name        = "status"
                type        = "string"
                description = "New status: one of Cancelled, Confirmed, OnHold, Amended."
              }
              property {
                name        = "reason"
                type        = "string"
                description = "Short human-readable reason for the change."
              }
              property {
                name        = "item_id"
                type        = "string"
                description = "The recon item id this change resolves (provenance)."
              }
              property {
                name        = "confidence"
                type        = "number"
                description = "Composite confidence as an INTEGER PERCENT [0..100]; the Policy engine gates this write on it."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the knowledge_base target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# NOTE: Graph itself is NOT a recon-owned gateway target. sendSharedMailboxMail and
# listSharedMailboxMessages are defined by the microsoft-graph OpenAPI target
# (module.microsoft_graph), which also owns the Graph credential — there is no send-notification
# target here, and nothing below talks to Graph directly. The `correspondence-search` target
# further down is a thin argument-sanitizing wrapper that calls that OpenAPI op through the
# gateway; see its own header comment for why it has to exist.

# ---------------------------------------------------------------------------------
# `recon-status` target: the PLATFORM-ONLY case-lifecycle write tool. The frontend BFF calls
# recon_update_status through the gateway (SigV4) instead of raw DynamoDB updates, so every
# human-driven transition gets can_transition enforcement, race-safe conditional writes, and
# an audit row naming the actor. Cedar (below) permits it exclusively for platform principals
# and forbids the agent/worker roles — the model can never move its own case.
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "recon_status" {
  name = "${var.name_prefix}-recon-status"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "recon_status" {
  name = "${var.name_prefix}-recon-status-policy"
  role = aws_iam_role.recon_status.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (all Describe
        # calls are account-wide), so it must stay on "*".
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        # VPC-attached Lambda ENI mutation IS resource-scopable — bound to this account/region.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${var.region}:${local.account_id}:*"
      },
      {
        # Guarded status transition (read current + conditional update) on the cases table.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = var.cases_table_arn
      },
      {
        # Append-only audit trail row per transition.
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = var.audit_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "recon_status" {
  function_name    = "${var.name_prefix}-recon-status"
  role             = aws_iam_role.recon_status.arn
  runtime          = "python3.12"
  handler          = "backend.status_tool.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 15

  environment {
    variables = {
      CASES_TABLE = var.cases_table
      AUDIT_TABLE = var.audit_table
    }
  }
}

resource "aws_bedrockagentcore_gateway_target" "recon_status" {
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "recon-status"
  description        = "Reconciliation workflow status tool (platform-only): guarded, audited case-lifecycle transitions"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.recon_status.arn
        tool_schema {
          inline_payload {
            name        = "recon_update_status"
            description = "Transition a reconciliation case to a new lifecycle status (platform callers only; guarded by the case state machine and audited)."
            input_schema {
              type = "object"
              property {
                name        = "item_id"
                type        = "string"
                description = "The reconciliation case / item id."
                required    = true
              }
              property {
                name        = "new_status"
                type        = "string"
                description = "Target status (PENDING, IN_PROGRESS, PROPOSED, APPROVED, REJECTED, RESOLVED, AUTO_CLEARED, AGED, CLOSED_NO_ACTION)."
                required    = true
              }
              property {
                name        = "comment"
                type        = "string"
                description = "Optional decision comment recorded on the audit row."
              }
              property {
                name        = "actor"
                type        = "string"
                description = "Acting principal label for the audit trail (e.g. analyst:jdoe, bff)."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the knowledge_base target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# ---------------------------------------------------------------------------------
# `correspondence-search` target: a SANITIZED wrapper over the Graph mailbox read.
#
# The microsoft-graph OpenAPI target advertises the OData query parameters as tool-schema
# property names — `$top` and `$search`. Bedrock's property pattern is
# ^[a-zA-Z0-9_.-]{1,64}$, so a $-prefixed name makes ConverseStream fail the moment that tool is
# offered to a model. The container runtime dodges this with an in-process Strands wrapper that
# builds the OData arguments out of the model's sight; the managed Harness has no equivalent
# hook, so listSharedMailboxMessages simply cannot be allowlisted there.
#
# This target is that wrapper, server-side: `search_correspondence(query, top)` uses plain,
# pattern-legal names and the Lambda assembles the OData form. It re-enters the gateway to call
# microsoft-graph___listSharedMailboxMessages rather than calling Graph directly, because the
# Graph credentials live in the AgentCore OAuth2 credential provider — there is no
# Lambda-readable copy of the Entra secret, and minting one would duplicate a credential and add
# a second unaudited path to the tenant. No loop risk: it calls a DIFFERENT target, never itself.
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "correspondence_search" {
  name = "${var.name_prefix}-correspondence-search"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "correspondence_search" {
  name = "${var.name_prefix}-correspondence-search-policy"
  role = aws_iam_role.correspondence_search.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (all Describe
        # calls are account-wide), so it must stay on "*".
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        # VPC-attached Lambda ENI mutation IS resource-scopable — bound to this account/region.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${var.region}:${local.account_id}:*"
      },
      {
        # Re-enter the egress gateway (SigV4) to invoke the Graph read op. This is the whole
        # point of the target: the Graph credential stays in the gateway's token vault.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = aws_bedrockagentcore_gateway.this.gateway_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "correspondence_search" {
  function_name    = "${var.name_prefix}-correspondence-search"
  role             = aws_iam_role.correspondence_search.arn
  runtime          = "python3.12"
  handler          = "backend.correspondence_tool.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  # Two hops (this Lambda -> gateway -> Graph), so allow more than the status tool's 15s.
  timeout = 30

  environment {
    variables = {
      RECON_GATEWAY_URL = aws_bedrockagentcore_gateway.this.gateway_url
      # The mailbox is deployment config, never a tool argument — the model must not be able to
      # redirect the read at another tenant mailbox.
      GRAPH_MAILBOX = var.graph_mailbox
    }
  }
}

resource "aws_bedrockagentcore_gateway_target" "correspondence_search" {
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "correspondence-search"
  description        = "Shared-mailbox correspondence search with a model-safe argument surface (no OData $-prefixed names)"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.correspondence_search.arn
        tool_schema {
          inline_payload {
            name        = "search_correspondence"
            description = "Search the shared operations mailbox for messages relevant to a reconciliation item (e.g. a draw reference, counterparty name, or invoice number)."
            input_schema {
              type = "object"
              property {
                name        = "query"
                type        = "string"
                description = "Free-text search terms, e.g. a draw reference like DRW-2026-00417 or a counterparty name. Quoting is handled for you."
                required    = true
              }
              property {
                name        = "top"
                type        = "integer"
                description = "Maximum number of messages to return (default 10, capped at 50)."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the knowledge_base target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# ---------------------------------------------------------------------------------
# AgentCore Policy: Cedar-based confidence gate on the egress gateway. The set_draw_status write
# is permitted ONLY when context.input.confidence >= the configured threshold — a hard
# guardrail the agent cannot cross, enforced by the gateway, not app code. Provider does not
# model Policy, so this uses null_resource + the AWS CLI (like microsoft-graph-obo).
# ---------------------------------------------------------------------------------

locals {
  policy_engine_name = "${replace(var.name_prefix, "-", "_")}_policy"
  gw_arn             = aws_bedrockagentcore_gateway.this.gateway_arn
  # Cedar: permit reads unconditionally; gate the two write-class tools on the confidence input.
  # Cedar has NO float/decimal literal type — comparisons use Long (integers). So the gate is on
  # an INTEGER PERCENT: the agent passes confidence as round(composite*100) in [0..100], and the
  # threshold is templated as an integer percent here.
  confidence_pct = floor(var.confidence_threshold * 100 + 0.5)
  # Reads are permitted unconditionally. The Microsoft Graph email ops (sendSharedMailboxMail +
  # listSharedMailboxMessages) are BOTH unconditional: the OpenAPI send op carries no confidence
  # parameter, so it cannot be confidence-gated — the write gate applies only to set_draw_status.
  # The IDP MCP target nests its tools under the server group `IDPTools`, so the Cedar action is
  # `document-extraction___IDPTools___get_results` (NOT `___get_results`). Lambda/OpenAPI targets
  # use the flat `target___tool` form.
  # `correspondence-search___search_correspondence` is the sanitized wrapper the model calls; the
  # wrapper Lambda then calls `microsoft-graph___listSharedMailboxMessages` itself, so BOTH
  # actions must be permitted — the second call arrives as the wrapper's own role, not the agent's.
  cedar_reads = "permit(principal, action in [AgentCore::Action::\"general-ledger___search_ledger\", AgentCore::Action::\"knowledge-base___search_guidance\", AgentCore::Action::\"document-extraction___IDPTools___get_results\", AgentCore::Action::\"correspondence-search___search_correspondence\", AgentCore::Action::\"microsoft-graph___listSharedMailboxMessages\", AgentCore::Action::\"microsoft-graph___sendSharedMailboxMail\"], resource == AgentCore::Gateway::\"${local.gw_arn}\");"
  # The gateway types `context.input.confidence` as a Cedar DECIMAL (the tool schema declares it a
  # number), so compare via the decimal extension — a bare `>= <Long>` fails validation. Guard the
  # optional attribute with `has` first. The agent passes confidence as an integer percent [0..100];
  # decimal("<pct>.0") is the same scale.
  cedar_write = "permit(principal, action == AgentCore::Action::\"set-draw-status___set_draw_status\", resource == AgentCore::Gateway::\"${local.gw_arn}\") when { context.input has confidence && context.input.confidence.greaterThanOrEqual(decimal(\"${local.confidence_pct}.0\")) };"

  # --- recon_update_status: PLATFORM-ONLY (Cedar principal gating) ---
  # Inbound auth is AWS_IAM, so principals are AgentCore::IamEntity. principal.id may surface as
  # the assumed-role session ARN or the bare role ARN (verify in dev decision logs) — each role
  # matches BOTH shapes. `like` needs the STS wildcard form; `==` covers a bare-role id.
  status_action = "AgentCore::Action::\"recon-status___recon_update_status\""
  # Three disjuncts per role: STS assumed-role session ARN, bare IAM role ARN, and a
  # shape-agnostic containing match (\"*<role>*\") — still scoped to the exact role name, and
  # tolerant of principal.id shapes the service may emit that differ from the first two
  # (observed live: an ECS task-role caller was denied although the assumed-role pattern
  # matched other principals of the same shape).
  principal_match = { for r in distinct(concat(var.platform_role_names, var.agent_role_names, [aws_iam_role.agent.name])) :
    r => "principal.id like \"arn:aws:sts::${local.account_id}:assumed-role/${r}/*\" || principal.id == \"arn:aws:iam::${local.account_id}:role/${r}\" || principal.id like \"*${r}*\""
  }
  platform_clause = length(var.platform_role_names) > 0 ? join(" || ", [for r in var.platform_role_names : local.principal_match[r]]) : "false"
  # NOTE: an explicit forbid for agent-side principals was rejected by AgentCore Policy's
  # automated-reasoning validation ("Overly Restrictive" for forbid + like-pattern conditions).
  # Platform-only access is guaranteed WITHOUT it: the policy engine is default-deny and the
  # only permit for recon_update_status is the principal-scoped platform permit above.

  cedar_status_platform = "permit(principal is AgentCore::IamEntity, action == ${local.status_action}, resource == AgentCore::Gateway::\"${local.gw_arn}\") when { ${local.platform_clause} };"

  # Human-approve permit: platform principals (the BFF) may execute set_draw_status WITHOUT a
  # confidence argument — a human decision is the authorization. Deliberately a separate,
  # principal-scoped permit (not confidence=100) so Cedar decision logs distinguish
  # human-authorized writes from genuine high-confidence autonomous ones. Must NEVER cover the
  # agent/worker roles: their writes ride recon_write_gate (confidence >= threshold) only.
  cedar_write_human = "permit(principal is AgentCore::IamEntity, action == AgentCore::Action::\"set-draw-status___set_draw_status\", resource == AgentCore::Gateway::\"${local.gw_arn}\") when { ${local.platform_clause} };"

}

# Native Terraform Policy management (migrated from the former null_resource + CLI pattern).
# MIGRATION NOTE (one-time, live env): import the existing engine + policies before the first
# apply, or accept a brief fail-closed window while they are recreated:
#   terraform import 'module.recon_agent.aws_bedrockagentcore_policy_engine.this' <engine-id>
#   terraform import 'module.recon_agent.aws_bedrockagentcore_policy.<name>' <engine-id>/<policy-id>
resource "aws_bedrockagentcore_policy_engine" "this" {
  name = local.policy_engine_name
}

resource "aws_bedrockagentcore_policy" "reads" {
  policy_engine_id = aws_bedrockagentcore_policy_engine.this.policy_engine_id
  name             = "recon_reads"
  definition {
    cedar {
      statement = local.cedar_reads
    }
  }

  # Cedar VALIDATES every action name against the gateway's live tool surface: naming a tool whose
  # target does not exist yet fails with `unrecognized action` and leaves the policy in
  # UPDATE_FAILED (observed live 2026-08-08 — the correspondence-search action was added in the
  # same apply that created its target, and Terraform, seeing no dependency, updated the policy
  # 4 minutes BEFORE the target existed). Nothing in the arguments creates that edge, so every
  # target named in `local.cedar_reads` that lives in THIS module is listed here explicitly.
  # The microsoft-graph target is created by the sibling module.microsoft_graph and cannot be
  # referenced from here; it is ordered only by the environment's module graph, so a from-scratch
  # deploy could still race on the two Graph actions.
  depends_on = [
    aws_bedrockagentcore_gateway_target.general_ledger,
    aws_bedrockagentcore_gateway_target.knowledge_base,
    aws_bedrockagentcore_gateway_target.correspondence_search,
    null_resource.idp_gateway_target,
  ]
}

resource "aws_bedrockagentcore_policy" "write_gate" {
  policy_engine_id = aws_bedrockagentcore_policy_engine.this.policy_engine_id
  name             = "recon_write_gate"
  definition {
    cedar {
      statement = local.cedar_write
    }
  }

  lifecycle {
    # The Config tab rewrites this statement's threshold at runtime via UpdatePolicy
    # (reconPolicy.ts). TF seeds the statement once; thereafter the Config tab owns it —
    # tfvars threshold changes do NOT propagate to this policy via TF.
    ignore_changes = [definition]
  }
}

resource "aws_bedrockagentcore_policy" "write_human" {
  policy_engine_id = aws_bedrockagentcore_policy_engine.this.policy_engine_id
  name             = "recon_write_human"
  definition {
    cedar {
      statement = local.cedar_write_human
    }
  }
}

resource "aws_bedrockagentcore_policy" "status_platform" {
  # The engine's auto-generated Cedar schema learns tool actions from the gateway's targets —
  # this policy validates only after the recon-status target exists.
  depends_on = [aws_bedrockagentcore_gateway_target.recon_status]

  policy_engine_id = aws_bedrockagentcore_policy_engine.this.policy_engine_id
  name             = "recon_status_platform"
  definition {
    cedar {
      statement = local.cedar_status_platform
    }
  }
}

resource "aws_iam_role" "ingress_gateway" {
  name = "${var.name_prefix}-ingress-gw"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "bedrock-agentcore.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "ingress_gateway" {
  name = "${var.name_prefix}-ingress-gw-policy"
  role = aws_iam_role.ingress_gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      # The ingress gateway proxies to the runtime, so its role must invoke the runtime.
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
      Resource = "${aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn}*"
    }]
  })
}

resource "aws_bedrockagentcore_gateway" "ingress" {
  name            = "${var.name_prefix}-ingress-gateway"
  role_arn        = aws_iam_role.ingress_gateway.arn
  authorizer_type = "AWS_IAM" # only internal IAM callers (Tier-1 worker, BFF) reach the agent

  protocol_configuration {
    mcp {
      supported_versions = ["2025-03-26"]
    }
  }
}

# http/agentcoreRuntime target (provider gap → CLI). Recreated when the runtime ARN changes.
resource "null_resource" "ingress_agent_target" {
  triggers = {
    gateway_id  = aws_bedrockagentcore_gateway.ingress.gateway_id
    runtime_arn = aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn
    aws_region  = var.region
  }

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      set -euo pipefail
      GW='${aws_bedrockagentcore_gateway.ingress.gateway_id}'
      REGION='${var.region}'
      CFG=$(jq -nc --arg arn '${aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn}' \
        '{http:{agentcoreRuntime:{arn:$arn}}}')
      EXISTING=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$GW" \
        --region "$REGION" --query "items[?name=='recon-agent'].targetId" --output text 2>/dev/null || true)
      if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
        aws bedrock-agentcore-control update-gateway-target --gateway-identifier "$GW" \
          --target-id "$EXISTING" --name recon-agent --region "$REGION" \
          --target-configuration "$CFG" --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' >/dev/null
      else
        aws bedrock-agentcore-control create-gateway-target --gateway-identifier "$GW" \
          --name recon-agent --description "Recon Tier-2 agent (ingress)" --region "$REGION" \
          --target-configuration "$CFG" --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' >/dev/null
      fi
    EOT
  }

  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    command    = <<-EOT
      set -euo pipefail
      GW='${self.triggers.gateway_id}'; REGION='${self.triggers.aws_region}'
      TID=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$GW" \
        --region "$REGION" --query "items[?name=='recon-agent'].targetId" --output text 2>/dev/null || true)
      [ -n "$TID" ] && [ "$TID" != "None" ] && aws bedrock-agentcore-control delete-gateway-target \
        --gateway-identifier "$GW" --target-id "$TID" --region "$REGION" >/dev/null 2>&1 || true
    EOT
  }
}
