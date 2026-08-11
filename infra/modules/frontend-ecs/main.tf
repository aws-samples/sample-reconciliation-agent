####################################################################################
# Frontend hosting on ECS Fargate behind an ALB, fronted by CloudFront — replicating the
# reference repo's `chat` module pattern. The standalone Next.js server image is built AND
# pushed by CodeBuild during a single `terraform apply` (build driver blocks until success),
# then run as a Fargate service. CloudFront (locked to the CloudFront origin-facing prefix
# list on the ALB SG) is the public HTTPS entry point.
####################################################################################

locals {
  prefix        = "${var.name_prefix}-frontend"
  ecr_repo_name = "${var.name_prefix}-frontend"
  s3_source_key = "frontend-source.zip"

  # Hash only source files that affect the build (avoid node_modules/.next churn).
  frontend_files = concat(
    [for f in fileset(var.frontend_dir, "src/**") : f],
    [for f in fileset(var.frontend_dir, "public/**") : f],
    [for f in fileset(var.frontend_dir, "*.{json,js,ts,mjs,cjs}") : f],
    [for f in fileset(var.frontend_dir, "Dockerfile") : f],
  )
  # Build-time config baked into the image as NEXT_PUBLIC_* build args. This MUST be part of
  # the image hash: the codebuild trigger skips when a tag already exists in ECR, so a config
  # change that doesn't move the hash (e.g. switching auth_provider to okta) would otherwise
  # keep serving the old image forever.
  build_config = join("|", [
    var.region, var.recon_api_base, var.cognito_hosted_ui, var.cognito_client_id,
    var.auth_provider, var.okta_issuer, var.okta_client_id, var.okta_redirect_uri,
  ])
  source_hash = sha1(join("", concat(
    [for f in local.frontend_files : try(filesha1("${var.frontend_dir}/${f}"), "")],
    [local.build_config],
  )))
}

# ============================================================
# Public subnets (2 AZs) + IGW route — an ALB requires >=2 AZs, and this account's default
# VPC only has subnets in one AZ. Create dedicated public subnets in the default VPC (which
# already has an internet gateway) so the whole thing still stands up in one apply.
# ============================================================

# Private-VPC mode (var.private_vpc=true) skips ALL of this public networking: no IGW route, no
# public subnets, no public IPs. The ALB + Fargate run on the caller-supplied private subnets and
# egress via the network module's interface endpoints instead. locals pick the subnet set once.
locals {
  # Subnets the ALB + Fargate attach to: private (caller-supplied) or the module's public ones.
  frontend_subnets = var.private_vpc ? var.private_subnet_ids : aws_subnet.public[*].id
  # Private-mode ALB ingress: explicit CIDRs, else fall back to the VPC CIDR (in-VPC only).
  private_alb_cidrs = length(var.private_ingress_cidrs) > 0 ? var.private_ingress_cidrs : (
    var.vpc_cidr != "" ? [var.vpc_cidr] : []
  )
}

data "aws_internet_gateway" "default" {
  count = var.private_vpc ? 0 : 1
  filter {
    name   = "attachment.vpc-id"
    values = [var.vpc_id]
  }
}

resource "aws_subnet" "public" {
  #checkov:skip=CKV_AWS_130:By design — this is a public subnet for the cost-optimized demo (Fargate task pulls its image and reaches CloudFront/AWS APIs directly, no NAT gateway); tasks are locked down by security groups and sit behind the ALB.
  count                   = var.private_vpc ? 0 : 2
  vpc_id                  = var.vpc_id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.prefix}-public-${var.availability_zones[count.index]}" }
}

resource "aws_route_table" "public" {
  count  = var.private_vpc ? 0 : 1
  vpc_id = var.vpc_id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = data.aws_internet_gateway.default[0].id
  }

  tags = { Name = "${local.prefix}-public" }
}

resource "aws_route_table_association" "public" {
  count          = var.private_vpc ? 0 : 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

# ============================================================
# ECR + source S3 + CodeBuild (build image in-apply)
# ============================================================

resource "aws_ecr_repository" "frontend" {
  #checkov:skip=CKV_AWS_136:Repo uses the default AES-256 ECR encryption at rest; a customer-managed KMS key adds key-management overhead not warranted for a demo image repo.
  #checkov:skip=CKV_AWS_51:Mutable tags are required — CodeBuild repeatedly overwrites the image tag on each demo rebuild; immutable tags would break the build/deploy loop.
  name                 = local.ecr_repo_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "frontend" {
  repository = aws_ecr_repository.frontend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_s3_bucket" "source" {
  bucket        = "${local.prefix}-src-${var.account_id}"
  force_destroy = true
}

# The CodeBuild source bundle is private-only; nothing about the build flow needs public
# ACLs or policies, so block all four public-access vectors (matches module.foundation).
resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "source" {
  bucket = aws_s3_bucket.source.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 7 }
  }
}

resource "null_resource" "upload_source" {
  triggers = { source_hash = local.source_hash }

  provisioner "local-exec" {
    working_dir = var.frontend_dir
    command     = <<-EOT
      set -e
      rm -f /tmp/${local.prefix}-src.zip
      zip -rq /tmp/${local.prefix}-src.zip . \
        -x 'node_modules/*' '.next/*' '.git/*' '__tests__/*' '*.log' '.DS_Store'
      aws s3 cp /tmp/${local.prefix}-src.zip \
        s3://${aws_s3_bucket.source.bucket}/${local.s3_source_key} \
        --region ${var.region}
    EOT
  }
}

resource "aws_iam_role" "codebuild" {
  name = "${local.prefix}-cb"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "cb-policy"
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
          "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
        ]
        Resource = aws_ecr_repository.frontend.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/codebuild/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [aws_s3_bucket.source.arn, "${aws_s3_bucket.source.arn}/*"]
      },
    ]
  })
}

resource "aws_codebuild_project" "frontend" {
  #checkov:skip=CKV_AWS_316:privileged_mode is required to run the Docker daemon for building the frontend container image; this is the documented CodeBuild pattern for Docker-in-CodeBuild builds.
  #checkov:skip=CKV_AWS_314:Build logs stream to the default CodeBuild CloudWatch group; a dedicated logs_config block is unnecessary for a demo build project.
  name          = "${local.prefix}-build"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 30

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    compute_type    = "BUILD_GENERAL1_MEDIUM"
    image           = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPO_URI"
      value = aws_ecr_repository.frontend.repository_url
    }
    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.account_id
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.region
    }
    environment_variable {
      name  = "RECON_API_BASE"
      value = var.recon_api_base
    }
    environment_variable {
      name  = "COGNITO_HOSTED_UI"
      value = var.cognito_hosted_ui
    }
    environment_variable {
      name  = "COGNITO_CLIENT_ID"
      value = var.cognito_client_id
    }
    environment_variable {
      name  = "SOURCE_HASH"
      value = local.source_hash
    }
    environment_variable {
      name  = "AUTH_PROVIDER"
      value = var.auth_provider
    }
    environment_variable {
      name  = "OKTA_ISSUER"
      value = var.okta_issuer
    }
    environment_variable {
      name  = "OKTA_CLIENT_ID"
      value = var.okta_client_id
    }
    environment_variable {
      name  = "OKTA_REDIRECT_URI"
      value = var.okta_redirect_uri
    }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.source.bucket}/${local.s3_source_key}"
    buildspec = <<-BUILDSPEC
      version: 0.2
      phases:
        pre_build:
          commands:
            - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
        build:
          commands:
            - |
              docker build \
                --build-arg NEXT_PUBLIC_AWS_REGION=$AWS_DEFAULT_REGION \
                --build-arg NEXT_PUBLIC_RECON_API_BASE=$RECON_API_BASE \
                --build-arg NEXT_PUBLIC_COGNITO_HOSTED_UI=$COGNITO_HOSTED_UI \
                --build-arg NEXT_PUBLIC_COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID \
                --build-arg NEXT_PUBLIC_AUTH_PROVIDER=$AUTH_PROVIDER \
                --build-arg NEXT_PUBLIC_OKTA_ISSUER=$OKTA_ISSUER \
                --build-arg NEXT_PUBLIC_OKTA_CLIENT_ID=$OKTA_CLIENT_ID \
                --build-arg NEXT_PUBLIC_OKTA_REDIRECT_URI=$OKTA_REDIRECT_URI \
                -t $ECR_REPO_URI:latest -t $ECR_REPO_URI:$SOURCE_HASH .
        post_build:
          commands:
            - docker push $ECR_REPO_URI:latest
            - docker push $ECR_REPO_URI:$SOURCE_HASH
    BUILDSPEC
  }
}

resource "null_resource" "codebuild_trigger" {
  triggers = { source_hash = local.source_hash }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      if aws ecr describe-images --repository-name "${local.ecr_repo_name}" \
        --image-ids imageTag="${local.source_hash}" --region ${var.region} >/dev/null 2>&1; then
        echo "Frontend image ${local.source_hash} already built, skipping."
        exit 0
      fi
      BUILD_ID=$(aws codebuild start-build --project-name "${aws_codebuild_project.frontend.name}" \
        --region ${var.region} --query 'build.id' --output text)
      echo "Frontend build: $BUILD_ID"
      for i in $(seq 1 180); do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region ${var.region} \
          --query 'builds[0].buildStatus' --output text)
        echo "  build status: $STATUS"
        case "$STATUS" in
          SUCCEEDED) exit 0 ;;
          FAILED|FAULT|STOPPED|TIMED_OUT) exit 1 ;;
        esac
        sleep 10
      done
      exit 1
    EOT
  }

  depends_on = [aws_codebuild_project.frontend, null_resource.upload_source, aws_iam_role_policy.codebuild]
}

# ============================================================
# ECS Cluster + Task + Service
# ============================================================

resource "aws_ecs_cluster" "this" {
  name = "${local.prefix}-cluster"
}

resource "aws_cloudwatch_log_group" "frontend" {
  #checkov:skip=CKV_AWS_158:Logs are encrypted with the default CloudWatch-managed key; a customer-managed CMK adds key-management overhead not warranted for demo logs.
  name = "/ecs/${local.prefix}"
  # 365-day retention satisfies the >= 1-year log-retention baseline (CKV_AWS_338).
  retention_in_days = 365
}

resource "aws_iam_role" "ecs_execution" {
  name = "${local.prefix}-ecs-exec"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.prefix}-ecs-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "ecs_task" {
  name = "task-policy"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
      {
        # Same-origin BFF routes read cases (+ status GSI) and update them, and read the
        # audit table — all via this task role (no cross-origin call to the API Gateway).
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = [var.cases_table_arn, "${var.cases_table_arn}/index/*", var.audit_table_arn]
      },
      {
        # Lessons ledger: the Lessons tab reads it (Query on domain-index / Scan)
        # and the approve/disapprove flow writes captured decisions (PutItem).
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [var.lessons_table_arn, "${var.lessons_table_arn}/index/*"]
      },
      {
        # Skills CRUD + system-prompt editor: BFF reads AND writes editable
        # SKILL.md / system-prompt.md under the assets bucket so edits apply without redeploy.
        # system-prompt-harness.md is read-only in practice but shares this statement: the
        # recommendations route must read whichever prompt the ACTIVE backend runs, because
        # StartRecommendation requires the current prompt as its optimization input.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "${var.assets_bucket_arn}/skills/*",
          "${var.assets_bucket_arn}/system-prompt.md",
          "${var.assets_bucket_arn}/system-prompt-harness.md",
          "${var.assets_bucket_arn}/skills-catalog.json",
        ]
      },
      {
        # Skills manager lists the skills/ prefix.
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = var.assets_bucket_arn
        Condition = { StringLike = { "s3:prefix" = ["skills/*"] } }
      },
      {
        # All BFF platform-tool calls ride the egress gateway (MCP + SigV4): the resolution
        # email (microsoft-graph___sendSharedMailboxMail), case-lifecycle transitions
        # (recon-status___recon_update_status, Cedar platform-only), and the human-approve
        # execution of the persisted proposed_action (set-draw-status___set_draw_status,
        # Cedar recon_write_human permit) — so Policy + the gateway interceptor bind human
        # actions exactly like agent actions.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = var.egress_gateway_arn != "" ? ["${var.egress_gateway_arn}*"] : ["*"]
      },
      {
        # Only the sample chat app (agentcore-runtime-client.ts) invokes its runtime directly.
        # The recon reject→reprocess path deliberately does not: it goes through the agent-worker
        # Lambda so the runtime⇄harness backend switch is honored.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = "*"
      },
      {
        # Reject→reprocess re-drives the investigation via the agent-worker Lambda (async),
        # which resolves the AGENT_BACKEND switch (runtime⇄harness).
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = var.agent_worker_function_arn != "" ? [var.agent_worker_function_arn] : ["arn:aws:lambda:*:*:function:${var.name_prefix}-agent-worker"]
      },
      {
        # Lessons <-> AgentCore Memory: the BFF WRITES each analyst decision as a memory event
        # (lessons_learned semantic strategy consolidates them for agent recall), and the
        # Lessons tab READS the consolidated long-term memory records back for display.
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:CreateEvent",
          "bedrock-agentcore:RetrieveMemoryRecords",
          "bedrock-agentcore:ListMemoryRecords",
          "bedrock-agentcore:GetMemoryRecord",
        ]
        Resource = var.recon_memory_arn != "" ? [var.recon_memory_arn, "${var.recon_memory_arn}/*"] : ["*"]
      },
      {
        # Config tab: Tier-1 toggle, auto-resolve threshold, comment mode, agent-backend
        # selector, and harness config-version pointer (read + write). Path-scoped to the
        # platform prefix so the two harness/evals params are covered without listing each ARN.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = "arn:aws:ssm:*:*:parameter/${var.name_prefix}/*"
      },
      {
        # Evals tab: 7-day metrics (CloudWatch) + recent per-session scores (Logs Insights).
        Effect = "Allow"
        Action = [
          "cloudwatch:GetMetricData",
          "logs:StartQuery", "logs:StopQuery", "logs:GetQueryResults",
          "logs:FilterLogEvents", "logs:DescribeLogGroups", "logs:GetLogEvents",
        ]
        Resource = "*"
      },
      {
        # Evals tab: on-demand batch evaluations + managed prompt/tool recommendations.
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:StartBatchEvaluation", "bedrock-agentcore:GetBatchEvaluation",
          "bedrock-agentcore:ListBatchEvaluations", "bedrock-agentcore:StartRecommendation",
          "bedrock-agentcore:GetRecommendation", "bedrock-agentcore:ListRecommendations",
        ]
        Resource = "*"
      },
      {
        # StartBatchEvaluation runs under a **FAS (forward access session)** derived from THIS
        # task role, and the service writes its results to a CloudWatch log group it names
        # itself (/aws/bedrock-agentcore/evaluations/batch-evaluations/results/<name>). It
        # provisions that group on every call — CreateLogGroup, then PutRetentionPolicy, then
        # TagResource — *unconditionally*, and IAM denies before the already-exists check, so
        # all of them are required even though the group already exists with retention set.
        # Missing any one fails the whole StartBatchEvaluation with "FAS credentials do not
        # have permission to <...>", which breaks BOTH the Evals-tab System-Prompt
        # recommendation (it runs a batch eval to assemble sessions) and the per-case
        # analyst-agreement re-score on approve/correct.
        #
        # The published batch-evaluation IAM policy in the AgentCore devguide
        # (batch-evaluations-prereqs) lists only *read* log actions and does NOT document this
        # provisioning chain — do not trim these back to match the docs. TagResource is granted
        # pre-emptively as the third call in the same chain: it costs nothing here and saves
        # another deploy round-trip, since a FAS can only be exercised by the running ECS task
        # (the trust policy admits ecs-tasks.amazonaws.com only) and cannot be tested locally.
        #
        # The generated group name is not predictable, so scope to this account/region's log
        # groups — same rationale and scope as the online-eval role in module.agent_evals.
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
          "logs:PutRetentionPolicy", "logs:TagResource",
        ]
        Resource = "arn:aws:logs:${var.region}:${var.account_id}:log-group:*"
      },
      {
        # Evals tab: versioned harness-config store (list/read/create v<NNNN>.json).
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${var.assets_bucket_arn}/harness-configs/*"
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = var.assets_bucket_arn
        Condition = { StringLike = { "s3:prefix" = ["harness-configs/*"] } }
      },
      {
        # Config tab: editing the threshold rewrites the gated Cedar policies (the enforcement
        # point). The BFF lists the engine/policies and updates the two gated statements.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:ListPolicyEngines", "bedrock-agentcore:ListPolicies", "bedrock-agentcore:UpdatePolicy", "bedrock-agentcore:GetPolicy"]
        Resource = "arn:aws:bedrock-agentcore:*:*:policy-engine/*"
      },
      {
        # Config tab (Tier-2 backend, Harness view): read the live harness config.
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:ListHarnesses", "bedrock-agentcore:GetHarness"]
        Resource = "*"
      },
      {
        # Config tab: read-only viewer of the seeded Tier-1 Lambda source.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${var.assets_bucket_arn}/lambda-src/*"
      },
      {
        # Case detail: stream document page previews (copied by the IDP hook at ingest).
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${var.assets_bucket_arn}/idp-pages/*"
      },
      {
        # List the lambda-src prefix for the viewer's file list.
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = var.assets_bucket_arn
        Condition = { StringLike = { "s3:prefix" = ["lambda-src/*"] } }
      },
    ]
  })
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = local.prefix
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = local.prefix
    image        = "${aws_ecr_repository.frontend.repository_url}:${local.source_hash}"
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "AWS_REGION", value = var.region },
      { name = "PORT", value = "3000" },
      # Consumed by the same-origin BFF API routes.
      { name = "CASES_TABLE", value = var.cases_table },
      { name = "AUDIT_TABLE", value = var.audit_table },
      { name = "ASSETS_BUCKET", value = var.assets_bucket },
      { name = "SKILLS_CATALOG_KEY", value = "skills-catalog.json" },
      # Editable skills / system prompt live under these S3 keys.
      { name = "SKILLS_PREFIX", value = "skills/" },
      { name = "SYSTEM_PROMPT_KEY", value = "system-prompt.md" },
      # The harness backend's prompt lives under its own key (same value the harness worker
      # reads via HARNESS_SYSTEM_PROMPT_KEY in module.tier1) — the recommendations route needs
      # it to optimize the prompt the harness is actually running.
      { name = "HARNESS_SYSTEM_PROMPT_KEY", value = "system-prompt-harness.md" },
      # Lessons-learned ledger.
      { name = "LESSONS_TABLE", value = var.lessons_table },
      # Approve emails via the microsoft-graph gateway tool (from the shared
      # mailbox); disapprove+reprocess re-invokes the agent.
      { name = "RECON_NOTIFY_EMAIL", value = var.notify_email },
      { name = "GRAPH_MAILBOX", value = var.graph_mailbox },
      # Counterparty-email draft: which domains an analyst may address. Comma-separated because
      # the Python authority (recon_core.email_policy.parse_domain_allowlist) and its TS mirror
      # both parse that shape — one wire format for both readers.
      { name = "COUNTERPARTY_EMAIL_DOMAINS", value = join(",", var.counterparty_email_domains) },
      { name = "RECON_GATEWAY_URL", value = var.egress_gateway_url },
      { name = "REPROCESS_CAP", value = tostring(var.reprocess_cap) },
      { name = "AGENT_RUNTIME_ARN", value = var.agent_runtime_arn },
      # Reject→reprocess re-drives the agent via the agent-worker Lambda (backend switch).
      { name = "AGENT_WORKER_FUNCTION", value = var.agent_worker_function_arn },
      # Config tab → Policy: rewrite the gated Cedar statements' threshold on the egress gateway.
      { name = "POLICY_ENGINE_NAME", value = var.policy_engine_name },
      { name = "EGRESS_GATEWAY_ARN", value = var.egress_gateway_arn },
      # Config tab — Tier-1 toggle param + read-only Lambda source prefix.
      { name = "TIER1_ENABLED_PARAM", value = var.tier1_enabled_param },
      { name = "LAMBDA_SRC_PREFIX", value = "lambda-src/tier1/" },
      # Lessons -> AgentCore Memory feed (distinct from the chatbot app's MEMORY_ID).
      { name = "RECON_MEMORY_ID", value = var.recon_memory_id },
      # Config tab: auto-resolve threshold SSM parameter.
      { name = "AUTO_RESOLVE_PARAM", value = var.auto_resolve_param },
      # Decision-comment requirement (required | optional | disapprove-only).
      { name = "COMMENT_REQUIREMENT_PARAM", value = var.comment_requirement_param },
      # Config tab: runtime agent-backend selector (runtime | harness).
      { name = "AGENT_BACKEND_PARAM", value = var.agent_backend_param },
      # Evals tab: config-version pointer + harness/eval log groups for metrics/results/batch.
      { name = "NAME_PREFIX", value = var.name_prefix },
      { name = "HARNESS_CONFIG_VERSION_PARAM", value = var.harness_config_version_param },
      { name = "EVAL_RESULTS_LOG_GROUP_PREFIX", value = var.eval_results_log_group_prefix },
      { name = "HARNESS_LOG_GROUP", value = var.harness_log_group },
      { name = "HARNESS_SERVICE_NAME", value = var.harness_service_name },
      { name = "ANALYST_AGREEMENT_EVALUATOR_ID", value = var.analyst_agreement_evaluator_id },
      # Human-confirmation token for the approve/notify email send (interceptor gate).
      { name = "EMAIL_CONFIRMATION_TOKEN", value = var.email_confirmation_token },
      # Account id for the recommendations route (tool-desc cloudwatchLogs ARN needs it).
      { name = "AWS_ACCOUNT_ID", value = var.account_id },
      # JSON maps keyed by backend id (harness/runtime) — batch evals + decision re-scores
      # resolve the active backend's data source from these.
      { name = "BACKEND_SERVICE_NAMES", value = jsonencode(var.backend_service_names) },
      { name = "BACKEND_EVENT_LOG_GROUPS", value = jsonencode(var.backend_event_log_groups) },
      # --- BFF authorization (src/proxy.ts + src/lib/api-auth.ts) ---
      # These are the RUNTIME copies of the auth config. The NEXT_PUBLIC_* build args above are
      # baked into the builder stage only, so the running container cannot read them; without
      # these three the middleware resolves "misconfigured" and returns 503 for every
      # /api/recon/* request (deliberately — it never falls back to allowing the call).
      { name = "AUTH_PROVIDER", value = var.auth_provider },
      { name = "OKTA_ISSUER", value = var.okta_issuer },
      { name = "OKTA_CLIENT_ID", value = var.okta_client_id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.frontend.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = local.prefix
      }
    }
  }])

  depends_on = [null_resource.codebuild_trigger]
}

# ALB ingress locked to the CloudFront origin-facing prefix list (public mode only).
data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = var.private_vpc ? 0 : 1
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

# ALB security group. Public mode: ingress 80 from the CloudFront managed prefix list. Private
# mode: ingress 80 from the allowlisted private CIDRs (VPN/VPC), never the internet.
resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = var.private_vpc ? "Frontend internal ALB (HTTP from private CIDRs)" : "Frontend ALB (HTTP from CloudFront prefix list)"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.private_vpc ? [] : [1]
    content {
      from_port       = 80
      to_port         = 80
      protocol        = "tcp"
      prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront[0].id]
    }
  }
  dynamic "ingress" {
    for_each = var.private_vpc ? [1] : []
    content {
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = local.private_alb_cidrs
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs" {
  name        = "${local.prefix}-ecs"
  description = "Frontend ECS tasks"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_150:Deletion protection is intentionally off so the demo stack can be torn down cleanly with terraform destroy; it would otherwise block automated teardown.
  name               = "${local.prefix}-alb"
  internal           = var.private_vpc
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.frontend_subnets
  idle_timeout       = 3600

  # Drop malformed HTTP headers at the ALB instead of forwarding them to the Next.js task,
  # which closes off request-smuggling / header-injection paths through the origin.
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "frontend" {
  name        = "${local.prefix}-tg"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  deregistration_delay = 30
  health_check {
    path                = "/api/health"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 10
  }
}

resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:TLS is terminated at CloudFront (viewer_protocol_policy=redirect-to-https); the ALB is an HTTP-only origin reachable ONLY from the CloudFront managed prefix list (see aws_security_group.alb), so an ALB-level HTTPS listener/cert is redundant for this demo.
  #checkov:skip=CKV_AWS_103:Origin listener is HTTP-only by design (CloudFront terminates TLS upstream); there is no TLS policy to set on this listener.
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_ecs_service" "frontend" {
  #checkov:skip=CKV_AWS_333:Public IP is required for the NAT-less demo (image pull + AWS API egress); inbound is locked to the ALB security group.
  name                               = local.prefix
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.frontend.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  # Public mode: a public IP lets the task pull its image + reach AWS APIs (NAT-less demo).
  # Private mode: no public IP; the task egresses via the network module's interface endpoints
  # (ECR/logs/etc.), and uses that module's SG (which permits 443 to the endpoints). Inbound is
  # restricted to the ALB SG in both modes.
  network_configuration {
    subnets          = local.frontend_subnets
    security_groups  = [var.private_vpc && var.ecs_private_security_group_id != "" ? var.ecs_private_security_group_id : aws_security_group.ecs.id]
    assign_public_ip = !var.private_vpc
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = local.prefix
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http]
}

# ============================================================
# CloudFront -> ALB
# ============================================================

# CloudFront and its log bucket exist ONLY in public mode. Private mode has no CloudFront at
# all (the internal ALB is the entry point, reached over VPN/VPC).
resource "aws_cloudfront_origin_request_policy" "this" {
  count   = var.private_vpc ? 0 : 1
  name    = "${local.prefix}-origin"
  comment = "Forward headers/cookies/query for the SPA + BFF"

  cookies_config { cookie_behavior = "all" }
  # allViewer also forwards Authorization, which the BFF middleware needs to verify the caller's
  # OIDC token (see chatbot-app/frontend/src/proxy.ts). Narrowing this would silently 401
  # every API call.
  headers_config { header_behavior = "allViewer" }
  query_strings_config { query_string_behavior = "all" }
}

# Security response headers, applied at CloudFront rather than in next.config.js `headers()` so
# they also cover static assets and CloudFront-generated error responses — neither of which reaches
# the Next.js server. Live QA 2026-08-09 found none of these headers present (P2-1).
resource "aws_cloudfront_response_headers_policy" "security" {
  count   = var.private_vpc ? 0 : 1
  name    = "${local.prefix}-security-headers"
  comment = "HSTS + nosniff + framing + referrer + permissions + CSP for the recon frontend"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000 # 2 years
      include_subdomains         = true
      # NOT preload: this serves from a shared *.cloudfront.net domain, and submitting it to the
      # HSTS preload list would force HTTPS on every other tenant of that domain.
      preload  = false
      override = true
    }

    content_type_options {
      override = true # X-Content-Type-Options: nosniff
    }

    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      # Written for what this app actually loads, not copied from a strict template: Next.js injects
      # inline hydration scripts and styled-jsx style tags, so a CSP without 'unsafe-inline' breaks
      # the UI outright, which is worse than a permissive-but-honest one. Tightening that needs the
      # nonce-based CSP flow in next.config.js, tracked as a follow-up.
      #
      # No font host is allowlisted. Every font (Manrope, Chivo, IBM Plex Mono) is loaded through
      # `next/font/google`, which fetches at BUILD time and emits @font-face rules pointing at
      # /_next/static/media — same origin. The earlier `fonts.googleapis.com` / `fonts.gstatic.com`
      # entries were added on the assumption those fetches happen in the browser; they do not, and
      # a fetch of the live page confirms zero references to either host. An allowlist entry nothing
      # uses is not free: it reads as evidence that loading from that CDN is supported.
      #
      # There is no `frame-src` either, and its absence is load-bearing. `default-src 'self'` blocks
      # framing, which blocks okta-auth-js's hidden-iframe silent renew — the browser logs
      # "Framing 'https://<org>.okta.com/' violates ... default-src 'self'". Do NOT answer that
      # console error by allowlisting the Okta host here. Silent renew is switched OFF in the client
      # instead (`oktaTokenManagerOptions` in src/lib/okta-config.ts) and expiry is handled by a
      # top-level redirect, because the iframe flow needs the provider's session cookie in a
      # third-party context — which Safari already blocks and Chrome is phasing out. Allowing the
      # frame would buy back a mechanism that fails again later, silently.
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' https://*.okta.com https://login.microsoftonline.com",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ])
      # override = false so the per-route CSP set by next.config.js `headers()` for /embed (which
      # deliberately widens frame-ancestors for iframe embedding) still wins where it is set.
      override = false
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      override = true
    }
  }
}

# Dedicated bucket for CloudFront standard (legacy) access logs. CloudFront log
# delivery writes objects owned by the log-delivery account, so the bucket must
# have ACLs enabled (Object Ownership = BucketOwnerPreferred) and grant the
# awslogsdelivery group write access — an ACL-based flow, not a bucket policy.
resource "aws_s3_bucket" "cloudfront_logs" {
  count         = var.private_vpc ? 0 : 1
  bucket        = "${local.prefix}-cf-logs-${var.account_id}"
  force_destroy = true
}

# Enable ACLs on the log bucket. CloudFront cannot deliver logs to a bucket that
# enforces BucketOwnerEnforced (ACLs disabled), so BucketOwnerPreferred is required.
resource "aws_s3_bucket_ownership_controls" "cloudfront_logs" {
  count  = var.private_vpc ? 0 : 1
  bucket = aws_s3_bucket.cloudfront_logs[0].id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

# Grant CloudFront's log-delivery group write access via a canned ACL.
resource "aws_s3_bucket_acl" "cloudfront_logs" {
  count = var.private_vpc ? 0 : 1
  # ACL can only be set once ownership controls permit ACLs.
  depends_on = [aws_s3_bucket_ownership_controls.cloudfront_logs]
  bucket     = aws_s3_bucket.cloudfront_logs[0].id
  acl        = "log-delivery-write"
}

# Block public access on the log bucket. This is compatible with the log-delivery-write ACL
# above: block_public_acls/ignore_public_acls only reject grants to the AllUsers and
# AuthenticatedUsers groups, and CloudFront's log delivery uses the s3/log-delivery group,
# which S3 does not classify as public. Sequenced after the ACL so the canned-ACL PUT is
# never evaluated against a partially-applied block.
resource "aws_s3_bucket_public_access_block" "cloudfront_logs" {
  count      = var.private_vpc ? 0 : 1
  depends_on = [aws_s3_bucket_acl.cloudfront_logs]

  bucket                  = aws_s3_bucket.cloudfront_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Expire CloudFront access logs to bound storage cost.
resource "aws_s3_bucket_lifecycle_configuration" "cloudfront_logs" {
  count  = var.private_vpc ? 0 : 1
  bucket = aws_s3_bucket.cloudfront_logs[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
  }
}

# Edge WAF for the distribution (security audit F7 / trivy AVD-AWS-0011). CloudFront is the only
# internet entry point for the whole app — it fronts the ALB, whose sole port-80 ingress is the
# CloudFront managed prefix list — so this is the one place a request filter can sit.
#
# IMPORTANT: a CLOUDFRONT-scoped web ACL MUST be created in us-east-1, no matter where the rest of
# the stack lives. This module has no provider block of its own and inherits the root provider, so
# the precondition below asserts the region rather than letting the API fail with an opaque
# WAFInvalidParameterException. If a non-us-east-1 environment is ever added, that environment must
# pass an aliased us-east-1 provider in for this resource.
resource "aws_wafv2_web_acl" "frontend" {
  count = var.private_vpc ? 0 : 1 # private mode has no CloudFront to attach to
  # local.prefix already ends in "-frontend", so "-waf" rather than another "-frontend".
  name  = "${local.prefix}-waf"
  scope = "CLOUDFRONT"

  # Allow by default: this is a filter in front of an authenticated app (Entra/Cognito OIDC on every
  # route), not an allowlist perimeter. Blocking by default would require enumerating every
  # legitimate BFF route here and would break on the next one added.
  default_action {
    allow {}
  }

  rule {
    name     = "aws-common-rule-set"
    priority = 1

    # `none {}` = do not override the rule group's own actions; each rule inside keeps its
    # configured action (mostly Block), except where rule_action_override says otherwise below.
    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # SizeRestrictions_BODY blocks any body over 8 KB. This app routinely exceeds that: the
        # system-prompt/harness config save, case proposals, and corrected classifications all POST
        # large JSON through the Next.js API routes. Count instead of Block keeps the match visible
        # in the WAF metrics and sampled requests without breaking those paths.
        #
        # This is an override, NOT an exclusion: the rule is still evaluated and still counted, so
        # the signal survives. Excluding it would remove the rule entirely.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.prefix}-common-rule-set"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-waf"
    sampled_requests_enabled   = true
  }

  lifecycle {
    precondition {
      condition     = var.region == "us-east-1"
      error_message = "A CLOUDFRONT-scoped WAF web ACL must be created in us-east-1, but var.region is not us-east-1. Pass an aliased us-east-1 provider to aws_wafv2_web_acl.frontend before deploying this module elsewhere."
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_305:No default_root_object — the origin is the Next.js app via the ALB, not S3; the root "/" must pass through to the app router, and rewriting it to /index.html would break server-rendered routes.
  #checkov:skip=CKV_AWS_174:Uses the default *.cloudfront.net certificate (no custom domain in the demo); the default cert already enforces modern TLS on the managed CloudFront domain. A custom ACM cert + minimum_protocol_version needs a registered domain.
  count           = var.private_vpc ? 0 : 1
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name_prefix} recon frontend (HTTPS)"
  price_class     = "PriceClass_100"

  # WAFv2 requires the web ACL *ARN* here despite the argument being named web_acl_id (the name
  # dates from WAF Classic, which took an id).
  web_acl_id = aws_wafv2_web_acl.frontend[0].arn

  # Standard access logging to the dedicated log bucket (CKV_AWS_86).
  logging_config {
    bucket          = aws_s3_bucket.cloudfront_logs[0].bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  origin {
    domain_name = aws_lb.this.dns_name
    origin_id   = "frontend-alb"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id           = "frontend-alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.this[0].id
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security[0].id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
