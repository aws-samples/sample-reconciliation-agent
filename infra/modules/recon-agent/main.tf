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
  idp_auth_endpoint = local.idp_mcp_cfg != null ? replace(local.idp_mcp_cfg.token_url, "/oauth2/token", "/oauth2/authorize") : ""

  # ⚠️ The issuer is NOT derivable from anything else here, and getting it wrong fails at token
  # validation rather than at apply.
  #
  # AgentCore validates a minted token's `iss` claim against the issuer declared on the provider.
  # Cognito's issuer is the cognito-idp form (https://cognito-idp.<region>.amazonaws.com/<poolId>),
  # which is a DIFFERENT HOST from the hosted-UI domain that serves the token endpoint — in this
  # deployment, pool us-east-1_GJxZkE3aX versus domain idp-unified-oji4rxy7. Neither the pool id nor
  # that host appears in token_url or in the gateway URL, so it cannot be computed.
  #
  # The retired shim discovered it at apply time by POSTing for a token with curl and base64-decoding
  # the JWT payload — four host tools (curl, jq, base64, cut) for one static string. It is deployment
  # config, so it now travels with the rest of the IDP config in idp_mcp_secret_json.
  idp_issuer = local.idp_mcp_cfg != null ? try(local.idp_mcp_cfg.issuer, "") : ""

  # The client secret is addressed inside the existing Secrets Manager document by key, so the
  # CloudFormation template references it instead of embedding the plaintext.
  idp_client_secret_json_key = "client_secret"
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
        # Auto-resolve's notification email resolves NOTIFY_CONTACT_ID to an address here. Note this
        # is the PLATFORM path (notify.py) reading the table directly, not the model: the model's
        # own view of contacts comes through the read-only gateway tool, which returns no address at
        # all. GetItem only, and nothing on the templates table — the notification wording is the
        # platform's, so the runtime has no reason to read an operator template.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = var.contacts_table_arn != "" ? var.contacts_table_arn : "arn:aws:dynamodb:*:*:table/__none__"
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
        # ⚠️ Required for the UNIFIED span destination, and its absence fails SILENTLY in the most
        # confusing possible way. AgentCore uses this action to put a resource policy on the agent's
        # own log group that permits AWS X-Ray to deliver spans into it.
        #
        # Without it, an agent on the unified destination loses its spans ENTIRELY rather than
        # falling back: AgentCore still creates the `spans` log stream (so the destination looks
        # configured), X-Ray cannot write to it, and because the agent is no longer on `aws/spans`
        # nothing lands there either except the platform's own `AgentCore.Runtime.Invoke` span.
        # Observed live 2026-09-07: a full 200-second investigation produced exactly ONE span, the
        # platform's, while the agent's `spans` stream sat at 0 bytes having never received an event.
        # Every other signal looked healthy -- the evaluation config ACTIVE at 100% sampling, ADOT
        # 0.19.0 installed, Transaction Search ACTIVE -- and the only visible symptom was cases
        # reporting "No evaluation recorded", because online evaluation cannot score one span.
        #
        # Scoped to this agent's log groups rather than "*": the delivery target is the agent's own
        # group, so a wildcard would grant the ability to rewrite resource policies on unrelated log
        # groups. If span delivery ever fails WITH this grant present, check whether the API is being
        # called against a group outside this prefix before widening it.
        Effect = "Allow"
        Action = ["logs:PutResourcePolicy"]
        Resource = [
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/${replace(var.name_prefix, "-", "_")}_agent-*",
          "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/${replace(var.name_prefix, "-", "_")}_agent-*:*",
        ]
      },
      {
        # ADOT in the container exports spans to the X-Ray OTLP endpoint with SigV4 (this
        # execution role). Without these actions every span export fails silently and the
        # online evaluators see no gen-ai spans at all. None of the X-Ray write/sampling
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
    MEMORY_ID = aws_bedrockagentcore_memory.this.id
    # No KB_ID: the container never calls Bedrock KB directly. Its knowledge-base read is an MCP
    # tool call to `managed-kb___Retrieve` over the gateway (gateway_mcp.py aliases it to the short
    # name `search_guidance`), and the knowledgeBaseId is bound admin-side on the connector target
    # -- deliberately NOT an exposed override, which is what stops the agent retargeting the tool.
    CASES_TABLE = var.cases_table
    AUDIT_TABLE = var.audit_table
    SKILLS_DIR  = "/app/skills"
    # Promote the worker's W3C baggage onto this runtime's spans (same allow-list as the Lambda and
    # the harness). Verified 2026-08-04: the baggage header propagates and the trace links either
    # way, but without this the recon.* keys are absent from the container's spans.
    OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = var.otel_baggage_span_attribute_keys
    # Deliver spans to THIS agent's own log group (the `spans` log stream in
    # /aws/bedrock-agentcore/runtimes/<agent_id>-<endpoint>) rather than the shared `aws/spans`.
    #
    # Set explicitly rather than left to the platform default. Agents created on or after
    # 2026-07-20 in a supported Region default to the unified destination, and this one does -- but
    # the default alone is not observable from Terraform, and relying on it left the destination
    # ambiguous while spans were going nowhere. Stating it makes the intent reviewable and survives
    # the agent being recreated in a Region whose support post-dates it.
    #
    # Requires all three of: Transaction Search enabled with segments to CloudWatch Logs, ADOT
    # >= 0.18.0 in the image (requirements.txt pins 0.19.0), and logs:PutResourcePolicy on this
    # role -- see the IAM statement above for what happens when that last one is missing.
    UNIFIED_TRACES_DESTINATION_ENABLED = "true"
    # ⚠️ Sample EVERY trace. Without this the ADOT distro uses the X-Ray CENTRALIZED sampler, which
    # fetches the account's rules and honours them -- and the account Default rule is FixedRate 0.05
    # with a reservoir of 1, so ~95% of this agent's traces are marked not-sampled and never
    # exported.
    #
    # The failure that produced is worth knowing, because it looks like anything except sampling:
    # spans ARE created (log records carry a real trace context) but nothing reaches the span
    # destination, so a trace shows exactly ONE span -- the platform's own AgentCore.Runtime.Invoke,
    # which the platform samples itself -- with 0 tokens and no gen-ai spans. Whether a given session
    # survived was pure dice: long investigations create many traces and usually got a few through,
    # short ones usually got none, which reads convincingly as "short sessions lose their spans" and
    # is not that at all.
    #
    # Sampling is the wrong tool here regardless of the rate. These traces feed ONLINE EVALUATION,
    # which can only score a session whose spans it can see, so a 5% sample silently discards 95% of
    # evaluation coverage. Set on the agent rather than by widening the account's X-Ray Default rule,
    # so this decision affects this agent and nothing else in the account.
    OTEL_TRACES_SAMPLER = "always_on"
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
    # Straight-through processing: the computed evidence-completeness score (satisfied / prescribed
    # required steps for the classified skill) >= this SSM threshold -> auto-resolve. There is no
    # composite: every model-reported confidence number was deleted on 2026-09-04.
    AUTO_RESOLVE_PARAM = var.auto_resolve_param
    LESSONS_TABLE      = var.lessons_table
    # Auto-resolve notification recipient, as a contact ID plus the table to resolve it in. The mail
    # is sent FROM the shared mailbox (GRAPH_MAILBOX) via the microsoft-graph gateway tool — no SES.
    # No address is stored here: notify.py looks it up per send and refuses a deactivated contact,
    # so revoking a recipient in the Config tab takes effect on the next case, not the next deploy.
    NOTIFY_CONTACT_ID = var.notify_contact_id
    CONTACTS_TABLE    = var.contacts_table
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
        # Recipient authorization: resolve a draft's contact_id (GetItem) and, for a notification
        # send, enumerate the active internal_notification contacts (Scan). Still read-only, so the
        # interceptor stays idempotent under the gateway's retries. Getting this grant wrong is
        # visible rather than silent -- the handler lets the AccessDeniedException surface as
        # "sendPurpose check failed", instead of treating an unreadable table as an empty one and
        # reporting that no recipient is configured.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Scan"]
        Resource = var.contacts_table_arn
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
      # The evidence guard reads the VERDICT off this row, which the provenance check already
      # fetches — so the whole guard costs no additional read. The notices table is deliberately NOT
      # here any more: the interceptor used to look up the cited notice and read its extraction alert
      # count, which only covered one of the two routes a document can take. The verdict is decided
      # at proposal time instead, over whatever the investigation actually cited.
      CASES_TABLE      = var.cases_table
      INTERCEPTOR_MODE = var.interceptor_mode
      # Email human-confirmation gate: the interceptor allows sendSharedMailboxMail only when the
      # call carries this token (provisioned to the human-driven send paths, NOT the agent
      # runtime), then strips it before forwarding to Graph.
      EMAIL_CONFIRMATION_TOKEN = var.email_confirmation_token
      # A `notification` send may only go to an ACTIVE internal_notification contact, and the
      # interceptor Scans for that set on each such send rather than caching it. A cache would keep
      # a deactivated recipient sendable for the length of its TTL, which is the exact window
      # deactivation exists to close. This env var is read with os.environ[...] for the same reason
      # NOTICES_TABLE is: an unset table must fail the check loudly, because an unreadable
      # recipient list and an empty one have to deny differently.
      CONTACTS_TABLE = var.contacts_table
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
# IDP MCP client-credentials config, stored for the agent to mint its bearer token. Guarded so it's a
# no-op when unset.
#
# This is the entire coupling surface the AGENT has to the document pipeline: one MCP target, no bucket
# or table ARNs. That rule is about the agent, not about the whole deployment. The console's Documents
# tab reads that pipeline's GraphQL API directly, server-side, on a signed-in human's click -- see the
# field-scoped appsync:GraphQL grant in modules/frontend-ecs. Two named read fields on a human-triggered
# path is a narrower dependency than mirroring every document event into a recon-owned table would be,
# and it cannot act on its own the way an agent tool can.
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

# ---------------------------------------------------------------------------------
# IDP document-extraction MCP target, and the OAuth2 credential provider it authenticates with.
#
# ⚠️ mcpServer targets support OAuth-CC/none outbound auth ONLY (never IAM), and creating one
# triggers an implicit synchronization (tools/list) that fails immediately without working
# credentials — so the target must be created WITH its credential config in the same call. That is
# why these two are a pair and not independent resources.
#
# The TARGET is native: aws 6.62.0 models `mcp { mcp_server { endpoint } }` alongside
# `credential_provider_configuration { oauth { ... } }`.
#
# The CREDENTIAL PROVIDER is CloudFormation, for the same reason as microsoft-graph-obo: the
# provider resource models no way to declare the authorization-server metadata this needs together
# with an externally-held client secret. AWS::BedrockAgentCore::OAuth2CredentialProvider does.
#
# Both used to be null_resource + AWS CLI, with a `data "external"` reading the provider ARN back at
# PLAN time. Between them they needed aws, jq, curl, base64 and cut on the machine running
# Terraform.
# ---------------------------------------------------------------------------------

resource "aws_cloudformation_stack" "idp_oauth_provider" {
  count = var.idp_gateway_target_url != "" && var.idp_mcp_secret_json != "" ? 1 : 0
  name  = "${var.name_prefix}-idp-oauth-provider"

  lifecycle {
    precondition {
      # Fail here, at plan, rather than letting AgentCore create a provider whose declared issuer is
      # the empty string. That provider reaches READY and only fails later, when a minted token's
      # `iss` claim is validated against it — surfacing as an opaque IDP tool failure at agent
      # runtime, a long way from its cause.
      condition     = local.idp_issuer != ""
      error_message = "idp_mcp_secret_json is missing the \"issuer\" key. It must be Cognito's real issuer (https://cognito-idp.<region>.amazonaws.com/<userPoolId>) — NOT the hosted-UI domain in token_url. Read it from the `iss` claim of a token minted against token_url, or from the IDP stack's user-pool id."
    }
  }

  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "OAuth2 credential provider for the IDP document-extraction MCP target (managed by Terraform; see infra/modules/recon-agent)."

    Resources = {
      Provider = {
        Type = "AWS::BedrockAgentCore::OAuth2CredentialProvider"
        Properties = {
          Name                     = local.idp_provider_name
          CredentialProviderVendor = "CustomOauth2"
          Oauth2ProviderConfigInput = {
            CustomOauth2ProviderConfig = {
              ClientId = local.idp_mcp_cfg.client_id
              # Referenced, not embedded: the same secret the agent's own idp_client.py reads, so
              # there is one copy of the credential and the template holds none of it.
              ClientSecretSource = "EXTERNAL"
              ClientSecretConfig = {
                SecretId = aws_secretsmanager_secret.idp_mcp[0].arn
                JsonKey  = local.idp_client_secret_json_key
              }
              OauthDiscovery = {
                # authorizationServerMetadata rather than a discovery URL: the endpoints live on the
                # hosted-UI domain while the issuer does not, so no single well-known document
                # describes both.
                AuthorizationServerMetadata = {
                  Issuer                = local.idp_issuer
                  AuthorizationEndpoint = local.idp_auth_endpoint
                  TokenEndpoint         = local.idp_mcp_cfg.token_url
                }
              }
            }
          }
        }
      }
    }

    Outputs = {
      CredentialProviderArn = {
        Description = "Provider ARN, referenced by the document-extraction target's oauth config."
        Value       = { "Fn::GetAtt" = ["Provider", "CredentialProviderArn"] }
      }
    }
  })

  depends_on = [aws_secretsmanager_secret_version.idp_mcp]
}

resource "aws_bedrockagentcore_gateway_target" "idp" {
  count = var.idp_gateway_target_url != "" && var.idp_mcp_secret_json != "" ? 1 : 0

  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = local.idp_target_name
  description        = "IDP document-extraction get_results(documentId) via MCP"

  target_configuration {
    mcp {
      mcp_server {
        endpoint = var.idp_gateway_target_url
      }
    }
  }

  credential_provider_configuration {
    oauth {
      provider_arn = aws_cloudformation_stack.idp_oauth_provider[0].outputs["CredentialProviderArn"]
      scopes       = [local.idp_mcp_cfg.scope]
      grant_type   = "CLIENT_CREDENTIALS"
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the general_ledger target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# Drop the retired CLI shims from state without running their destroy provisioners, which would
# delete the very provider and target being adopted.
#
# ⚠️ ONE-TIME MANUAL STEP before the first apply in an environment that already has this provider.
# `Name` is create-only on the CFN type, so the existing provider cannot be adopted and
# CreateOauth2CredentialProvider collides on the name:
#
#   aws bedrock-agentcore-control delete-oauth2-credential-provider \
#     --name recon-dev-idp-mcp-provider --region <region>
#
# The provider ARN is derived from the name, so the recreated provider gets the same ARN and the
# imported target below keeps resolving. IDP tool calls fail between the delete and the apply.
removed {
  from = null_resource.idp_oauth_provider

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.idp_gateway_target

  lifecycle {
    destroy = false
  }
}

# ---------------------------------------------------------------------------------
# Knowledge Base service role.
#
# Shared by design: this one role backs the MANAGED knowledge base defined below. It used to back
# a second, CUSTOMER-managed KB (type = "VECTOR") over an S3 Vectors index, which Phase 3 deleted
# along with the Lambda tool that read it -- hence the policy below is now S3-read + nothing else.
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

# ⚠️ There is no `s3vectors:*` and no `bedrock:InvokeModel` grant here, and neither is missing.
# A MANAGED knowledge base owns its vector store and picks its own embedding model, so the service
# does that work under its own identity, not this role's. The only thing this role needs is read
# access to the data-source bucket -- and it needs it BEFORE CreateKnowledgeBase, which probes it.
#
# The deleted grants belonged to the customer-managed KB: `s3vectors:QueryVectors` et al. over
# `${var.name_prefix}-kb-vectors` / `-kb-index`, and InvokeModel on amazon.titan-embed-text-v2:0
# for the 1024-dimension cosine index it embedded with. If you ever reintroduce a customer-managed
# KB, note that CreateKnowledgeBase 403s on a missing s3vectors:QueryVectors.
resource "aws_iam_role_policy" "kb" {
  name = "${var.name_prefix}-kb-policy"
  role = aws_iam_role.kb.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [var.assets_bucket_arn, "${var.assets_bucket_arn}/*"]
      },
    ]
  })
}

# ---------------------------------------------------------------------------------
# Bedrock-MANAGED Knowledge Base + connector data source
#
# This is the ONLY knowledge base in the platform. It is MANAGED for a hard reason: the AgentCore
# Gateway `bedrock-knowledge-bases` connector target accepts nothing else -- a customer-managed KB
# (type = "VECTOR") makes CreateGatewayTarget fail. That constraint is what drove the whole
# migration.
#
# It ingests the assets bucket's knowledge-base/ prefix. A second, customer-managed KB over an S3
# Vectors index used to ingest the same prefix during the coexistence window; Phase 3 deleted it.
# It could not hold this corpus anyway -- S3 Vectors ignores sidecar metadata FILES over 1024 bytes
# outright and hard-fails filterable metadata over 2048 bytes, so it indexed 3 of 15 documents. See
# the note above local.kb_ingest_targets in infra/environments/recon/main.tf.
# ---------------------------------------------------------------------------------

resource "aws_bedrockagent_knowledge_base" "managed" {
  name     = "${var.name_prefix}-kb-managed"
  role_arn = aws_iam_role.kb.arn

  knowledge_base_configuration {
    type = "MANAGED"
    managed_knowledge_base_configuration {
      # "MANAGED" means Bedrock picks and owns the embedding model, so embedding_model_arn is
      # deliberately absent -- that field pairs with embedding_model_type = "CUSTOM".
      embedding_model_type = "MANAGED"
    }
  }

  # No storage_configuration on purpose: the service provisions and owns the vector store. This
  # is the difference between a managed and a customer-managed KB, not an omission.

  # The role's S3 read policy must exist before CreateKnowledgeBase runs its validation probe
  # against the data source bucket, or the create 403s.
  depends_on = [aws_iam_role_policy.kb]
}

# ⚠️ A MANAGED knowledge base does NOT take an `S3` data source. `CreateDataSource` with
# type = "S3" fails with `ValidationException: Unsupported data source type for MANAGED knowledge
# base type` (observed live 2026-08-26). Managed KBs reach S3 through the CONNECTOR data-source
# type, whose S3 details live in a free-form `connectorParameters` document — and note it wants a
# bucket NAME, not the bucket ARN that s3_configuration takes.
#
# The provider types `connector_parameters` as a plain string, so it is jsonencode'd here. That
# means Terraform cannot validate its contents: a typo inside this document is a runtime
# ValidationException, not a plan error.
#
# The service supplies three values of its own for this data source, and all three are DECLARED below
# so the plan converges. They are, exactly (captured live 2026-09-02):
#
#     connectorParameters.aclEnabled                          = false
#     connectorParameters.filterConfiguration.maxFileSizeInMegaBytes = "500"
#     mediaExtractionConfiguration.imageExtractionConfiguration.imageExtractionStatus = "ENABLED"
#
# Until 2026-09-02 none of them were declared, so every plan proposed REMOVING all three, the apply
# succeeded, and the service put them straight back — a permanently non-empty plan that trained
# reviewers to skim it.
#
# Two earlier notes here were wrong, and correcting them is what made the fix possible:
#
#   1. `media_extraction_configuration` is NOT under `vector_ingestion_configuration`. The provider
#      schema (aws 6.56.0) puts it under
#      `data_source_configuration.managed_knowledge_base_connector_configuration`. It is a fully typed
#      block, so it can simply be declared.
#   2. Declaring the values DOES converge. The old note said `connector_parameters` was "one opaque
#      string" whose contents Terraform could not tell apart from drift. The provider in fact renders
#      it as a NORMALIZED JSON object diff (verified in a real plan: it listed exactly the two added
#      keys), so ordering and whitespace are not in play. What the old note did correctly establish is
#      that applying the REMOVAL never converges — the service re-adds its defaults. That was never a
#      test of declaring them.
#
# ⚠️ These three values are now OURS, not the service's. If AWS changes a default, this resource shows
# a diff again — and that is the CORRECT outcome, a service changing behaviour under a deployed system.
# Do NOT read a future diff here as "the known perpetual no-op": that reading no longer applies, and it
# is now the only thing standing between a service-side change and a reviewer noticing it.
resource "aws_bedrockagent_data_source" "managed" {
  name              = "${var.name_prefix}-kb-managed-seed"
  knowledge_base_id = aws_bedrockagent_knowledge_base.managed.id

  data_source_configuration {
    type = "MANAGED_KNOWLEDGE_BASE_CONNECTOR"
    managed_knowledge_base_connector_configuration {
      connector_parameters = jsonencode({
        type    = "S3"
        version = "1"
        connectionConfiguration = {
          bucketName           = var.assets_bucket
          bucketOwnerAccountId = local.account_id
        }
        filterConfiguration = {
          inclusionPrefixes = ["knowledge-base/"]
          # Service default, declared so the plan converges. See the note above.
          maxFileSizeInMegaBytes = "500"
        }
        # Service default. ACLs are not used here; declared to converge, not to enable anything.
        aclEnabled = false
      })

      # The service enables image extraction for an S3 connector and returns this block whether or not it
      # was asked for. Declared for the same reason as the two keys above.
      #
      # `audio_extraction_configuration` and `video_extraction_configuration` are deliberately NOT
      # declared: the service does not return them for an S3 connector, so declaring them would create
      # the mirror image of the diff this is fixing.
      media_extraction_configuration {
        image_extraction_configuration {
          image_extraction_status = "ENABLED"
        }
      }
    }
  }

  vector_ingestion_configuration {
    parsing_configuration {
      # SMART_PARSING is what makes the .pdf and .xlsx evidence in the corpus actually indexable.
      # The default parser handles text formats only; on a binary it would ingest the object and
      # index no extractable text — retrievable, citable, and evidence-free. Unlike
      # BEDROCK_FOUNDATION_MODEL this strategy needs no model ARN sub-block.
      parsing_strategy = "SMART_PARSING"
    }
  }
}

# ⚠️ CreateDataSource is ASYNCHRONOUS for a managed KB: the data source sits in CREATING for
# ~2-5 minutes before reaching AVAILABLE, and an ingestion job started before then fails. The
# Terraform resource returns as soon as the API accepts the call, so nothing else establishes
# this wait.
#
# The ingestion resource lives in the ENVIRONMENT, not this module, so it cannot depends_on this
# gate directly. Instead `output "managed_kb_data_source_id"` reads the id back OUT of this
# invocation's input — that routes the real dependency edge through the output, so the
# environment's ingestion job cannot start until this poll has returned.
#
# Was a local-exec poll driving the AWS CLI; now the deploy-actions Lambda does the polling in the
# account. `aws_lambda_invocation` is synchronous and fails the apply on a function error, so the
# gate behaves exactly as before without needing a CLI on the machine running Terraform.
# Forget the retired CLI poll (no destroy provisioner; `destroy = false` keeps a no-op out of the
# plan's DELETE list, which the CI destroy guard matches exactly).
removed {
  from = null_resource.managed_kb_data_source_available

  lifecycle {
    destroy = false
  }
}

resource "aws_lambda_invocation" "managed_kb_data_source_available" {
  function_name = var.deploy_actions_function_name

  input = jsonencode({
    action            = "wait_kb_data_source"
    knowledge_base_id = aws_bedrockagent_knowledge_base.managed.id
    data_source_id    = aws_bedrockagent_data_source.managed.data_source_id
    # Re-run the wait when the actor's code changes, not just when the ids do. Without this the
    # invocation is keyed only on its arguments and would keep replaying a cached result from a
    # previous version of the handler.
    handler_version = var.deploy_actions_source_code_hash
  })
}

# ---------------------------------------------------------------------------------
# There is deliberately NO knowledge-base Lambda here any more. The agent's only
# knowledge-base read is the `managed-kb` connector target (kb-connector-target.tf), which the
# Gateway calls with its OWN role -- see the KbConnectorRetrieve grant in `gateway_tools` below.
# The retired path was a `recon-dev-kb-search` Lambda wrapping bedrock:Retrieve against the
# customer-managed KB, exposed as the `knowledge-base` target with a flat
# search_guidance(query, top_k) schema. It could not express a metadata filter, which is the
# whole reason for the connector target.
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
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        # One entry for the contact-store Lambda even though TWO targets point at it — the grant is
        # on the function, and the targets differ only in the tool name they pass through.
        Resource = compact([aws_lambda_function.recon_status.arn, aws_lambda_function.correspondence_search.arn, var.gl_tool_lambda_arn, var.set_draw_status_lambda_arn, var.notice_tool_lambda_arn, var.contact_tool_lambda_arn])
      },
      {
        # The `managed-kb` connector target (kb-connector-target.tf) calls Bedrock with the
        # GATEWAY's role, not a Lambda's.
        #
        # ⚠️ GetKnowledgeBase is not optional and is easy to miss: target validation is
        # ASYNCHRONOUS and calls it. Without this grant the target is created successfully and
        # then flips to CREATE_FAILED ~30s later, with the real cause only in statusReasons.
        Sid      = "KbConnectorValidate"
        Effect   = "Allow"
        Action   = ["bedrock:GetKnowledgeBase"]
        Resource = aws_bedrockagent_knowledge_base.managed.arn
      },
      {
        # Retrieve only -- deliberately NOT AgenticRetrieveStream, which requires Resource "*".
        # This grant plus Enabled = ["Retrieve"] on the target are the two halves of that limit.
        Sid      = "KbConnectorRetrieve"
        Effect   = "Allow"
        Action   = ["bedrock:Retrieve"]
        Resource = aws_bedrockagent_knowledge_base.managed.arn
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
        #
        # ⚠️ The second entry is the CUSTOMER-managed secret, and it is not redundant. A credential
        # provider created with an explicit `ClientSecretConfig.SecretId` keeps pointing at that
        # secret rather than copying it under the service prefix, so the gateway reads the caller's
        # own secret when minting the token. `modules/microsoft-graph-obo` does exactly that, and
        # without this entry every `search_correspondence` call failed with
        # `ToolDenied: ... Failed to fetch outbound oauth token. Access denied when retrieving the
        # provided secret ... assumed-role/<prefix>-gateway ... is not authorized to perform:
        # secretsmanager:GetSecretValue`. That failure is nearly invisible: the tool returns an error
        # the agent records as one more unproductive step, so the case still completes -- with its
        # correspondence evidence silently missing.
        #
        # Matched by NAME PATTERN rather than by ARN on purpose. `module.microsoft_graph` already
        # depends on this module for `gateway_id`, so referencing its secret ARN here would close a
        # module-level cycle that Terraform rejects outright. The name is deterministic
        # (`${var.name_prefix}-graph-oauth`) and the trailing `-*` covers only Secrets Manager's own
        # six-character suffix, so this is one named secret and not a prefix wildcard.
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:bedrock-agentcore-identity!default/oauth2/*",
          "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.name_prefix}-graph-oauth-*",
        ]
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
              # Exact-match codes, unlike borrower/facility above. Substring matching a fund code
              # would make FUND-DL-I match FUND-DL-II too.
              property {
                name        = "fund_code"
                type        = "string"
                description = "Fund / portfolio code the entry belongs to, e.g. FUND-DL-I (exact match)."
              }
              property {
                name        = "loanx_id"
                type        = "string"
                description = "LoanX ID of the facility (exact match). Use after resolving an identifier via the facility crosswalk."
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
    # AgentCore itself adds `metadata_configuration.allowed_request_headers =
    # ["x-amzn-bedrock-agentcore-policy-session-id"]` to every target of a policy-enabled
    # gateway (it carries the Cedar session id), and the block CANNOT be declared here: the
    # provider rejects any `X-Amzn-`-prefixed header. Without this ignore, Terraform plans the
    # block's removal on every run and the service re-adds it, forever.
    # Note this does not cover a target's CREATE, where the provider still errors
    # with "block count changed from 0 to 1" — the target is created and recorded in state, but
    # ends up tainted and needs `terraform untaint`.
    #
    # It also does not cover a target's UPDATE. `ignore_changes` only suppresses the DIFF; the
    # provider still builds UpdateGatewayTarget from state, so the injected header travels with any
    # other change to the target and the call is rejected outright:
    #   ValidationException: Header 'x-amzn-bedrock-agentcore-policy-session-id' is restricted and
    #   cannot be configured
    # Consequence: once a target has been created and the service has injected the header, its tool
    # schema can no longer be edited in place. Change it with
    # `terraform apply -replace=<target address>`, then `terraform untaint` the recreated target per
    # the CREATE note above. Adding a tool argument therefore briefly removes the tool.
    #
    # This is the canonical copy of the note; the other targets below point here. (It used to live
    # on the `knowledge-base` target, which Phase 3 deleted.) The `managed-kb` connector target is
    # the one target that needs NO such ignore — aws_cloudformation_stack diffs on template_body
    # and parameters only, so a service-injected property cannot show up as drift.
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
    # Service-managed and undeclarable — see the general_ledger target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# The ACTUAL side's retrieval target, mirroring `general-ledger`. A notice is evidence ABOUT an item,
# never the thing that creates one — this target is read-only and there is no notices write tool.
resource "aws_bedrockagentcore_gateway_target" "notices" {
  count              = var.notice_tool_enabled ? 1 : 0
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "notices"
  description        = "Extracted counterparty notices (the actual side) — search by counterparty, fund, reference, amount with tolerance, or notice-date window"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = var.notice_tool_lambda_arn
        tool_schema {
          inline_payload {
            name        = "search_notices"
            description = "Search EXTRACTED counterparty notices. A field this notice's class never extracts is reported in fields_unavailable, which is NOT a non-match. An empty rows list means searched-and-found-nothing; read failures raise."
            input_schema {
              type = "object"
              property {
                name        = "counterparty"
                type        = "string"
                description = "Counterparty name exactly as extracted from the notice."
              }
              property {
                name        = "fund"
                type        = "string"
                description = "Fund/portfolio label. Resolve aliases with your skill's alias table first."
              }
              property {
                name        = "reference"
                type        = "string"
                description = "Exact wire/transaction reference on the notice."
              }
              property {
                name        = "amount"
                type        = "string"
                description = "Amount to match, as a decimal string. Non-numeric input is an error, not a wildcard."
              }
              property {
                name        = "amount_tolerance"
                type        = "string"
                description = "Symmetric tolerance around amount, as a decimal string. Requires amount."
              }
              property {
                name        = "date_from"
                type        = "string"
                description = "Earliest notice date (YYYY-MM-DD)."
              }
              property {
                name        = "date_to"
                type        = "string"
                description = "Latest notice date (YYYY-MM-DD)."
              }
              property {
                name        = "notice_class"
                type        = "string"
                description = "Notice class, e.g. wire_confirmation or remittance_advice — what kind of DOCUMENT this is, as the extraction classified it."
              }
              property {
                name        = "activity_type"
                type        = "string"
                description = "What the notice REPORTS: Interest, Rateset, Rollover, Commitment Fee, Paydown. A different axis from notice_class. A notice carrying none is still returned, with activity_type in fields_unavailable."
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
    # Service-managed and undeclarable — see the general_ledger target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# ---------------------------------------------------------------------------------
# `contacts` + `templates`: the two reads that let the model cite a recipient and a wording BY ID
# instead of authoring either one.
#
# TWO targets in front of ONE Lambda, and that is not redundancy. The gateway composes the exposed
# tool name as <target>___<tool>, so a single target named `contacts` carrying both schemas would
# expose the second tool as `contacts___list_templates` -- a name the Cedar permit, the harness
# allowlist, and the runtime's tool map all fail to match, which filters the tool out silently
# rather than erroring. The design fixes the names contacts___list_contacts and
# templates___list_templates; the target names are what produce them.
#
# Both are read-only, and there is no write counterpart anywhere on this gateway. That is the
# control: adding a recipient is an operator action through the Config tab, so the model cannot
# introduce an address even if it decides it wants to.
# ---------------------------------------------------------------------------------

resource "aws_bedrockagentcore_gateway_target" "contacts" {
  count              = var.contact_tool_enabled ? 1 : 0
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "contacts"
  description        = "Who the platform may email — the operator's list of counterparty and internal-notification contacts. Read-only, and addresses are never returned."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = var.contact_tool_lambda_arn
        tool_schema {
          inline_payload {
            name = "list_contacts"
            # Says outright that no address comes back, because a model that expects one and gets
            # a row without it will otherwise try to reconstruct it from the item's documents --
            # which is exactly the address an outside party would have chosen for us.
            description = "List the contacts an email may be addressed to. Returns {\"rows\": [...], \"count\": n} where each row has contact_id, display_name, kind and active. It does NOT return an email address and there is no way to ask for one: cite the contact_id and the platform resolves the address when it sends."
            input_schema {
              type = "object"
              property {
                name        = "kind"
                type        = "string"
                description = "Filter to one kind: counterparty (an outside party) or internal_notification (your own operations team). Omit for all."
              }
              property {
                name        = "active_only"
                type        = "boolean"
                description = "Default true. Deactivated contacts cannot be sent to, so leave this alone unless you are auditing."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the general_ledger target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

resource "aws_bedrockagentcore_gateway_target" "templates" {
  count              = var.contact_tool_enabled ? 1 : 0
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  name               = "templates"
  description        = "The wording the platform may send — operator-authored email templates. Read-only, and the subject/body bytes are never returned."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        # Same Lambda as the `contacts` target above. It dispatches on the tool name the gateway
        # passes in client_context, so one deployable holds the "never return an address, never
        # return the body" projection for both reads.
        lambda_arn = var.contact_tool_lambda_arn
        tool_schema {
          inline_payload {
            name = "list_templates"
            # Withholding the subject/body is the point: handed the bytes, a model pastes back a
            # mutated copy, which then fails the platform's own render-and-compare on send.
            description = "List the email templates you may choose from. Returns {\"rows\": [...], \"count\": n} where each row has template_id, name, purpose, variables and active. The subject and body are NOT returned — pick by name, cite the template_id, and supply a value for each name in variables. The operator's wording is what gets sent."
            input_schema {
              type = "object"
              property {
                name        = "purpose"
                type        = "string"
                description = "Filter to one purpose: counterparty or internal_notification. Must match the contact's kind — a counterparty template cannot be sent to an internal contact."
              }
              property {
                name        = "active_only"
                type        = "boolean"
                description = "Default true. Deactivated templates cannot be sent."
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the general_ledger target for the full note.
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
                description = "Target status (PENDING, IN_PROGRESS, PROPOSED, APPROVED, REJECTED, RESOLVED, AUTO_CLEARED, AGED, CLOSED_NO_ACTION, FAILED)."
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
    # Service-managed and undeclarable — see the general_ledger target for the full note.
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
    # Service-managed and undeclarable — see the general_ledger target for the full note.
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
  # an INTEGER PERCENT: auto_resolve.py passes round(evidence_completeness*100) in [0..100], and the
  # threshold is templated as an integer percent here. Platform code injects that value — the model
  # is never offered set_draw_status (it is absent from ALLOWED_TOOLS), so it cannot author it.
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
  # `managed-kb___Retrieve` is the connector target (see kb-connector-target.tf) and is now the ONLY
  # knowledge-base read any agent path takes — the Phase 2 cutover completed and was verified live on
  # both backends 2026-08-27 (L29 + L30).
  # The retired Lambda-backed `knowledge-base___search_guidance` action was dropped from this permit
  # one apply AFTER its target was deleted — see the depends_on note below for why that order is
  # mandatory, before adding or removing any action here.
  # `contacts___list_contacts` and `templates___list_templates` are TWO actions from two targets in
  # front of one Lambda. Cedar validates the literal action string against the gateway's live tool
  # surface, so `contacts___list_templates` — the name a single combined target would have produced —
  # is not an abbreviation of the second entry; it is an unrecognized action that would put this
  # whole policy in UPDATE_FAILED and cost the agent every read.
  cedar_reads = "permit(principal, action in [AgentCore::Action::\"general-ledger___search_ledger\", AgentCore::Action::\"notices___search_notices\", AgentCore::Action::\"managed-kb___Retrieve\", AgentCore::Action::\"document-extraction___IDPTools___get_results\", AgentCore::Action::\"correspondence-search___search_correspondence\", AgentCore::Action::\"contacts___list_contacts\", AgentCore::Action::\"templates___list_templates\", AgentCore::Action::\"microsoft-graph___listSharedMailboxMessages\", AgentCore::Action::\"microsoft-graph___sendSharedMailboxMail\"], resource == AgentCore::Gateway::\"${local.gw_arn}\");"
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
  #
  # ⚠️ The reverse race applies when RETIRING a target, and it takes TWO applies. Dropping an
  # action and deleting its target cannot ride one apply: the depends_on edge that would order the
  # two is ITSELF deleted along with the target, so Terraform is free to update the policy first —
  # and a `recon_reads` stuck in UPDATE_FAILED costs the agent EVERY read tool, because Cedar fails
  # closed. Split every target retirement the same way: the first apply deletes the target while
  # leaving this statement byte-identical (no UpdatePolicy planned => no revalidation), the second
  # drops the now-dangling action from `local.cedar_reads` once the target is already gone.
  depends_on = [
    aws_bedrockagentcore_gateway_target.general_ledger,
    aws_bedrockagentcore_gateway_target.notices,
    aws_bedrockagentcore_gateway_target.correspondence_search,
    # All three are count-gated, so reference the whole list rather than [0] — an indexed reference
    # to an absent resource fails to resolve instead of simply contributing no edge. The IDP target
    # is absent when idp_gateway_target_url/idp_mcp_secret_json are unset.
    aws_bedrockagentcore_gateway_target.idp,
    # Named individually, not as one group: an empty list is a SATISFIED dependency, so with
    # contact_tool_enabled = false the two actions above would be validated against a gateway that
    # advertises neither tool. That combination is a misconfiguration, not a supported mode —
    # enabling the actions and enabling the targets is one decision.
    aws_bedrockagentcore_gateway_target.contacts,
    aws_bedrockagentcore_gateway_target.templates,
    # For `managed-kb___Retrieve` the dependency is the READINESS GATE, not the CloudFormation
    # stack. The stack can reach CREATE_COMPLETE while the target is still CREATING (validation is
    # async, ~30s), and a target in CREATING advertises no tools — which is precisely the
    # `unrecognized action` race described above. See kb-connector-target.tf.
    aws_lambda_invocation.kb_connector_target_ready,
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

# The ingress gateway's http/agentcoreRuntime target: what actually routes an InvokeGateway call
# through to the Tier-2 runtime.
#
# ⚠️ This was a null_resource + AWS CLI shim until 2026-09-02, and the reason it moved is not
# tidiness. `targetConfiguration.http` is a NEWER member than `mcp`, so the shim's payload was
# correct while the *tool* was stale: any runner whose AWS CLI bundles an older botocore fails with
# `Unknown parameter in targetConfiguration: "http"`. That is unfixable from inside Terraform —
# there is no CLI version to pin on a build image you do not own. The provider models it natively
# as of aws 6.62.0, so the version floor in providers.tf is load-bearing; do not relax it.
#
# Built by the CodeBuild project rather than by a local docker run, so `terraform apply` needs no
# container toolchain.
resource "aws_bedrockagentcore_gateway_target" "ingress_agent" {
  gateway_identifier = aws_bedrockagentcore_gateway.ingress.gateway_id
  name               = "recon-agent"
  description        = "Recon Tier-2 agent (ingress)"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    http {
      agentcore_runtime {
        # No `qualifier`: the shim pointed at the unqualified runtime ARN, so the target follows
        # whatever the runtime's DEFAULT endpoint serves. Setting one here would pin the ingress
        # path to a single runtime version and silently strand it on the next image deploy.
        arn = aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn
      }
    }
  }

  lifecycle {
    # Service-managed and undeclarable — see the general_ledger target for the full note.
    ignore_changes = [metadata_configuration]
  }
}

# Drop the shim from state WITHOUT running its destroy provisioner.
#
# ⚠️ `destroy = false` is the whole point. A plain deletion would run the `when = destroy`
# provisioner above, which calls delete-gateway-target on the LIVE target — the same target the
# import block in the environment root is adopting into the resource above. That would either
# delete the adopted target out from under Terraform or, on a runner with no working AWS CLI,
# fail silently under `on_failure = continue`. Forgetting the state entry is the only ordering
# that is correct in both places.
removed {
  from = null_resource.ingress_agent_target

  lifecycle {
    destroy = false
  }
}
