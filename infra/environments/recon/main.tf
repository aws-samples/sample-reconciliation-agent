####################################################################################
# Recon platform — dev environment root. Wires the platform modules together.
# Terraform is the sole deploy mechanism for 100% of the platform.
####################################################################################

data "aws_caller_identity" "current" {}

# Single shared Lambda deployment package. Every Python Lambda (intake, tier1, idp-hook,
# api BFFs) imports the backend as `from backend....`, so the zip must contain a top-level
# backend/ package. This module builds it once; the Lambda modules reference the same zip.
module "lambda_package" {
  source      = "../../modules/lambda-package"
  backend_dir = "${path.root}/../../../backend"
}

# Default VPC for the ECS/ALB frontend. The frontend-ecs module creates its own 2-AZ public
# subnets inside it (the account's default VPC has subnets in only one AZ; an ALB needs two).
data "aws_vpc" "default" {
  default = true
}

# Private networking: subnets + NAT + S3/DynamoDB PrivateLink endpoints for all
# VPC-attached compute (Lambdas + AgentCore Runtime).
# Shared secret gating email sends at the gateway interceptor (human-confirmation safeguard).
# keepers empty → generated once and stable across applies (rotate by tainting this resource).
resource "random_password" "email_confirmation" {
  length  = 40
  special = false
}

module "network" {
  source = "../../modules/network"

  name_prefix = var.name_prefix
  region      = var.region
  vpc_id      = data.aws_vpc.default.id
  # Private-VPC mode adds the interface endpoints (Bedrock/AgentCore/SSM/ECS/ELB/…) so the
  # frontend + backend reach every AWS dependency with no NAT/IGW. One flag drives everything.
  enable_private_endpoints = var.private_vpc
}

locals {
  vpc_subnets = module.network.private_subnet_ids
  vpc_sgs     = [module.network.security_group_id]

  # ADOT Python layer for the agent-worker Lambda. var.otel_layer_account is AWS's public publisher
  # for AWSOpenTelemetryDistroPython in every commercial region (a variable rather than a literal
  # only because the pre-push guard rejects 12-digit runs — see variables.tf); the layer is
  # arch-agnostic and covers python3.10-3.14. This is the distro layer AWS documents for
  # Lambda-hosted agents — NOT the older aws-otel-python collector layer, which ADDS a collector
  # (unsupported for agent observability) and ships an incompatible OTel version.
  otel_layer_arn = var.enable_worker_tracing ? "arn:aws:lambda:${var.region}:${var.otel_layer_account}:layer:AWSOpenTelemetryDistroPython:${var.otel_layer_version}" : ""

  # One definition shared by the worker Lambda (which SETS these baggage keys) and the harness
  # (which promotes them to span attributes) — they must not drift apart. The first two are
  # AgentCore's own; the recon.* keys come from backend/recon_core/otel_client.py.
  otel_baggage_span_attribute_keys = "harness.id,harness.endpoint.qualifier,session.id,recon.item_id,recon.domain,recon.backend"
}

module "foundation" {
  source = "../../modules/foundation"

  name_prefix      = var.name_prefix
  hosted_ui_prefix = var.hosted_ui_prefix
  # Cognito client is created with placeholder callbacks (no frontend dependency, to avoid a
  # foundation<->frontend cycle). The real CloudFront callback/logout URLs are patched in by
  # null_resource.cognito_callbacks below, once the frontend distribution exists — same
  # post-hoc pattern the reference repo uses for its OAuth callback registration. One apply.
}

module "frontend" {
  source = "../../modules/frontend-ecs"

  name_prefix  = var.name_prefix
  region       = var.region
  account_id   = data.aws_caller_identity.current.account_id
  frontend_dir = "${path.root}/../../../chatbot-app/frontend"
  vpc_id       = data.aws_vpc.default.id

  # Build-time NEXT_PUBLIC_* wiring (Cognito OAuth + recon BFF base).
  recon_api_base    = module.intake.api_endpoint
  cognito_hosted_ui = "${module.foundation.hosted_ui_domain}.auth.${var.region}.amazoncognito.com"
  cognito_client_id = module.foundation.spa_client_id

  # Identity provider selection (Okta OIDC vs Entra) — baked into the frontend build.
  auth_provider     = var.auth_provider
  okta_issuer       = var.okta_issuer
  okta_client_id    = var.okta_client_id
  okta_redirect_uri = var.okta_redirect_uri

  # BFF data access (same-origin /api/recon/* routes read these via the ECS task role).
  cases_table       = module.foundation.cases_table
  cases_table_arn   = module.foundation.cases_table_arn
  audit_table       = module.foundation.audit_table
  audit_table_arn   = module.foundation.audit_table_arn
  assets_bucket     = module.foundation.assets_bucket
  assets_bucket_arn = module.foundation.assets_bucket_arn

  # Lessons ledger + approve-email / reprocess re-invocation.
  lessons_table     = module.foundation.lessons_table
  lessons_table_arn = module.foundation.lessons_table_arn
  # Approve email: sent FROM the shared mailbox via the egress gateway's microsoft-graph tool.
  notify_email       = var.notify_email
  graph_mailbox      = var.graph_mailbox
  egress_gateway_url = module.recon_agent.gateway_url
  reprocess_cap      = var.reprocess_cap
  # Counterparty-email draft: the domains an analyst may address. Same value the interceptor gets,
  # so the BFF's inline rejection and the gateway's denial agree about what is addressable.
  counterparty_email_domains = var.counterparty_email_domains

  # Lessons -> AgentCore Memory feed (agent recalls them on future similar items).
  recon_memory_id   = module.recon_agent.memory_id
  recon_memory_arn  = module.recon_agent.memory_arn
  agent_runtime_arn = module.recon_agent.runtime_arn
  # Reject→reprocess re-drives the agent via the agent-worker Lambda (backend switch honored);
  # approve executes the persisted proposed_action THROUGH the gateway's set_draw_status tool.
  agent_worker_function_arn = module.tier1.worker_function_arn
  # Config tab → Policy: rewrite the gated Cedar statements' threshold on change.
  policy_engine_name = module.recon_agent.policy_engine_name
  egress_gateway_arn = module.recon_agent.gateway_arn

  # Config tab: deterministic Tier-1 toggle + auto-resolve threshold.
  tier1_enabled_param = module.foundation.tier1_enabled_param
  auto_resolve_param  = module.foundation.auto_resolve_param

  comment_requirement_param = module.foundation.comment_requirement_param

  # Config tab backend selector + Evals tab (config-version pointer + eval/harness log groups).
  agent_backend_param           = module.foundation.agent_backend_param
  harness_config_version_param  = module.foundation.harness_config_version_param
  eval_results_log_group_prefix = module.agent_evals.results_log_group_prefix
  harness_log_group             = "aws/spans"
  harness_service_name          = local.backend_service_names.harness
  # Batch route maps the UI's 'analyst_agreement' alias to the real evaluator id.
  analyst_agreement_evaluator_id = module.agent_evals.evaluator_id
  # Backend-aware batch/re-score data sources (same maps the online eval configs use).
  backend_service_names    = local.backend_service_names
  backend_event_log_groups = local.backend_event_log_groups

  # Private-VPC deployment (ONE flag): no CloudFront, internal ALB on private subnets, Fargate
  # with no public IP egressing via the network module's interface endpoints. Default false
  # keeps the public CloudFront topology unchanged.
  private_vpc                   = var.private_vpc
  private_subnet_ids            = module.network.private_subnet_ids
  ecs_private_security_group_id = module.network.security_group_id
  vpc_cidr                      = module.network.vpc_cidr
  private_ingress_cidrs         = var.private_ingress_cidrs
  email_confirmation_token      = random_password.email_confirmation.result
}

# Patch the Cognito SPA client's OAuth callback/logout URLs to the CloudFront domain after the
# frontend distribution is up. Breaks the foundation<->frontend cycle (depends only forward).
resource "null_resource" "cognito_callbacks" {
  triggers = {
    distribution = module.frontend.distribution_domain
    client_id    = module.foundation.spa_client_id
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      aws cognito-idp update-user-pool-client \
        --region ${var.region} \
        --user-pool-id ${module.foundation.user_pool_id} \
        --client-id ${module.foundation.spa_client_id} \
        --allowed-o-auth-flows code \
        --allowed-o-auth-scopes openid email profile \
        --allowed-o-auth-flows-user-pool-client \
        --supported-identity-providers COGNITO \
        --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH \
        --callback-urls "https://${module.frontend.distribution_domain}/callback" \
        --logout-urls "https://${module.frontend.distribution_domain}/"
    EOT
  }
}

module "intake" {
  source = "../../modules/intake"

  name_prefix            = var.name_prefix
  items_table            = module.foundation.items_table
  items_table_arn        = module.foundation.items_table_arn
  user_pool_endpoint     = module.foundation.user_pool_endpoint
  spa_client_id          = module.foundation.spa_client_id
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

module "tier1" {
  source = "../../modules/tier1"

  email_confirmation_token = random_password.email_confirmation.result

  name_prefix        = var.name_prefix
  lambda_zip         = module.lambda_package.zip_path
  lambda_source_hash = module.lambda_package.source_code_hash
  items_stream_arn   = module.foundation.items_stream_arn
  items_table_arn    = module.foundation.items_table_arn
  cases_table        = module.foundation.cases_table
  cases_table_arn    = module.foundation.cases_table_arn
  audit_table        = module.foundation.audit_table
  audit_table_arn    = module.foundation.audit_table_arn
  agent_runtime_arn  = module.recon_agent.runtime_arn

  # Invoke the agent THROUGH the ingress gateway (validated live) with a direct-invoke fallback.
  ingress_gateway_url = module.recon_agent.ingress_gateway_url
  ingress_gateway_arn = module.recon_agent.ingress_gateway_arn
  use_ingress_gateway = true

  # Harness-backend execute path: the worker performs the Policy-gated ledger write through
  # the EGRESS tools gateway and sends the resolution email (model is propose-only).
  egress_gateway_arn = module.recon_agent.gateway_arn
  egress_gateway_url = module.recon_agent.gateway_url
  graph_mailbox      = var.graph_mailbox
  notify_email       = var.notify_email

  # Backend selector + harness config (used when agent_backend="harness").
  agent_backend                = var.agent_backend
  harness_arn                  = module.recon_agent_harness.harness_arn
  harness_model_id             = var.harness_model_id
  system_prompt_key            = "system-prompt.md"
  harness_system_prompt_key    = "system-prompt-harness.md"
  assets_bucket                = module.foundation.assets_bucket
  assets_bucket_arn            = module.foundation.assets_bucket_arn
  skills_prefix                = "skills/"
  lessons_table                = module.foundation.lessons_table
  lessons_table_arn            = module.foundation.lessons_table_arn
  memory_id                    = module.recon_agent.memory_id
  memory_arn                   = module.recon_agent.memory_arn
  auto_resolve_param           = module.foundation.auto_resolve_param
  harness_config_version_param = module.foundation.harness_config_version_param
  agent_backend_param          = module.foundation.agent_backend_param

  # Deterministic Tier-1 toggle read at runtime.
  tier1_enabled_param     = module.foundation.tier1_enabled_param
  tier1_enabled_param_arn = module.foundation.tier1_enabled_param_arn

  # Client-side OTel tracing: links the worker's invocation to the agent's own spans in ONE trace
  # and stamps recon.item_id onto them. Empty layer ARN turns the whole thing off.
  otel_layer_arn                   = local.otel_layer_arn
  otel_baggage_span_attribute_keys = local.otel_baggage_span_attribute_keys

  # Deterministic GL lookup (mocked general ledger).
  gl_query_function_name = module.gl_mock.function_name
  gl_query_function_arn  = module.gl_mock.function_arn
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

module "recon_agent" {
  source = "../../modules/recon-agent"

  name_prefix            = var.name_prefix
  region                 = var.region
  agent_src_dir          = "${path.root}/../../../agent-blueprint/recon-agent"
  cases_table            = module.foundation.cases_table
  cases_table_arn        = module.foundation.cases_table_arn
  audit_table            = module.foundation.audit_table
  audit_table_arn        = module.foundation.audit_table_arn
  assets_bucket          = module.foundation.assets_bucket
  assets_bucket_arn      = module.foundation.assets_bucket_arn
  idp_gateway_target_url = var.idp_gateway_target_url
  idp_mcp_secret_json    = var.idp_mcp_secret_json

  # Cedar principal gating for the platform-only recon_update_status tool. Role NAMES are
  # constructed by naming convention — referencing module outputs here would create a
  # frontend<->recon-agent dependency cycle. The frontend module names its task role
  # "<prefix>-frontend-ecs-task"; harness/tier1 name theirs "<prefix>-harness-exec" /
  # "<prefix>-agent-worker".
  platform_role_names = ["${var.name_prefix}-frontend-ecs-task"]
  agent_role_names    = ["${var.name_prefix}-harness-exec", "${var.name_prefix}-agent-worker"]

  # Gateway REQUEST interceptor mode: log (observe only) or enforce (block on violation).
  interceptor_mode = var.interceptor_mode

  # Counterparty-email recipient allowlist, enforced on the send at the gateway.
  counterparty_email_domains = var.counterparty_email_domains

  # Same baggage allow-list as the Lambda + harness, so the runtime backend's spans carry
  # recon.item_id / recon.domain / recon.backend too.
  otel_baggage_span_attribute_keys = local.otel_baggage_span_attribute_keys

  # Email human-confirmation gate: the interceptor + the platform send paths share this token;
  # the agent runtime container also gets it (only platform code notify.py injects it — the model
  # never reads env), but the model's own counterparty-email tool call carries no token → blocked.
  email_confirmation_token = random_password.email_confirmation.result

  # Gateway Lambda tools (kb-search built from the shared zip; general-ledger from gl-mock).
  lambda_zip         = module.lambda_package.zip_path
  lambda_source_hash = module.lambda_package.source_code_hash
  gl_tool_lambda_arn = module.gl_mock.function_arn
  gl_tool_enabled    = true
  # Write tool: the agent (when confident) + human-approve path set draw/ledger status here.
  set_draw_status_lambda_arn = module.gl_mock.write_function_arn
  set_draw_status_enabled    = true
  vpc_subnet_ids             = local.vpc_subnets
  vpc_security_group_ids     = local.vpc_sgs

  # Auto-resolve (straight-through processing): threshold param + lesson ledger + email.
  auto_resolve_param     = module.foundation.auto_resolve_param
  auto_resolve_param_arn = module.foundation.auto_resolve_param_arn
  lessons_table          = module.foundation.lessons_table
  lessons_table_arn      = module.foundation.lessons_table_arn
  notify_email           = var.notify_email
  # Shared mailbox the agent's Microsoft Graph email tools send from / read (GRAPH_MAILBOX).
  graph_mailbox = var.graph_mailbox

  # AgentCore Policy confidence gate: LOG_ONLY first, flip to ENFORCE (Task 9) after inspecting
  # live Cedar decision logs from the harness runs.
  policy_enforcement_mode = var.policy_enforcement_mode
}

# Managed AgentCore Harness sibling (A/B via agent_backend). Reuses the egress gateway (awsIam
# outbound), assets bucket (skills + prompt), and the same skill set as the runtime blueprint.
module "recon_agent_harness" {
  source = "../../modules/recon-agent-harness"

  name_prefix        = var.name_prefix
  region             = var.region
  harness_config_dir = "${path.root}/../../../agent-blueprint/recon-agent-harness"
  gateway_arn        = module.recon_agent.gateway_arn
  harness_model_id   = var.harness_model_id
  assets_bucket      = module.foundation.assets_bucket
  assets_bucket_arn  = module.foundation.assets_bucket_arn
  skills_prefix      = "skills/"
  # Bind each seeded skill (skills/<name>/) as a harness skill source.
  skill_names = [
    for f in fileset("${path.root}/../../../agent-blueprint/recon-agent/skills", "*.md") :
    trimsuffix(f, ".md")
  ]
  system_prompt = file("${path.root}/../../../agent-blueprint/recon-agent-harness/system-prompt.md")

  # Harness OTel configuration. The baggage allow-list MUST match the worker Lambda's (same local)
  # — the worker sets the keys, the harness promotes them to span attributes.
  otel_baggage_span_attribute_keys = local.otel_baggage_span_attribute_keys
  # Deliberately NOT enabled here (unlike on the worker Lambda): the online evaluators score
  # gen-ai CONTENT records read from this harness's log group, and both settings suppress content.
  # See the harness OTel-observability design record, D2.
  otel_genai_content_extraction_opt_out = false
  otel_semconv_stability_opt_in         = ""

  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

# Agent evaluations: custom analyst-agreement evaluator + online eval config.
module "agent_evals" {
  source = "../../modules/agent-evals"

  name_prefix            = var.name_prefix
  region                 = var.region
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  lessons_table          = module.foundation.lessons_table
  lessons_table_arn      = module.foundation.lessons_table_arn
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs

  # Score sessions from BOTH agent backends (one eval config per entry — the service
  # caps serviceNames at one per config). Runtime spans additionally require the
  # observability module's enable_xray_traces = true (below).
  service_names = local.backend_service_names
  # Each backend's runtime log group carries the gen-ai event records (conversation
  # content) the judges read; the eval service only queries configured log groups.
  event_log_groups = local.backend_event_log_groups
}

# OTel service.name per agent backend: AgentCore emits "<runtimeName>.DEFAULT"; the managed
# harness's runtime is created under a "harness_" prefix (harness_name "recon_dev_harness"
# -> runtime "harness_recon_dev_harness"). Shared by the eval configs and the frontend's
# batch-eval/recommendation routes.
locals {
  backend_service_names = {
    harness = "harness_${module.recon_agent_harness.harness_name}.DEFAULT"
    runtime = "${module.recon_agent.runtime_name}.DEFAULT"
  }
  # Per-backend runtime log groups holding the OTel gen-ai event records (conversation
  # content); every eval data source (online configs, batch, decision re-score) needs the
  # active backend's group listed — the eval service reads content only from configured groups.
  backend_event_log_groups = {
    harness = module.recon_agent_harness.harness_runtime_log_group
    runtime = module.recon_agent.runtime_log_group
  }
}

# Seed the harness's CALLING CONTRACT to S3 (submit_proposal fields + prefixed gateway tool
# names). This is appended after the shared policy core in system_prompt_seed below — the policy
# itself is NOT duplicated here, so the two backends cannot drift apart. Create-only like the
# other editable objects: repo edits need a manual `aws s3 cp` to reach the live object.
resource "aws_s3_object" "harness_system_prompt_seed" {
  bucket       = module.foundation.assets_bucket
  key          = "system-prompt-harness.md"
  source       = "${path.root}/../../../agent-blueprint/recon-agent-harness/system-prompt.md"
  etag         = filemd5("${path.root}/../../../agent-blueprint/recon-agent-harness/system-prompt.md")
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source]
  }
}

# Skills-catalog BFF only. The former JWT cases API was removed — the UI's decisions run in
# the frontend's same-origin BFF via the gateway's platform tools (one HITL code path).
module "api" {
  source = "../../modules/api"

  name_prefix            = var.name_prefix
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  api_id                 = module.intake.api_id
  authorizer_id          = module.intake.authorizer_id
  api_execution_arn      = module.intake.execution_arn
  assets_bucket          = module.foundation.assets_bucket
  assets_bucket_arn      = module.foundation.assets_bucket_arn
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

# CloudWatch log groups for the platform's Lambdas.
module "lambda_logs" {
  source = "../../modules/lambda-logs"

  lambda_function_names = [
    "${var.name_prefix}-intake",
    "${var.name_prefix}-tier1",
    "${var.name_prefix}-agent-worker",
    "${var.name_prefix}-recon-status",
    module.api.skills_function_name,
  ]
}

# AgentCore runtime observability: OTEL application logs -> CloudWatch + traces -> X-Ray.
module "observability" {
  source = "../../modules/observability"

  project_name  = var.name_prefix
  environment   = "dev"
  resource_name = "recon-agent-runtime"
  resource_arn  = module.recon_agent.runtime_arn

  # Deliver runtime TRACES into aws/spans so the online eval config can score
  # runtime-backend sessions (account-level Transaction Search enabled 2026-07-27).
  enable_xray_traces = true
}

# Upload the KB seed corpus to the assets bucket's knowledge-base/ prefix.
resource "aws_s3_object" "kb_seed" {
  bucket = module.foundation.assets_bucket
  key    = "knowledge-base/resolution-patterns.md"
  source = "${path.root}/../../../data/kb-seed/resolution-patterns.md"
  etag   = filemd5("${path.root}/../../../data/kb-seed/resolution-patterns.md")
}

# Reconciliation guidance/playbooks for the recon KB (consult-guidance skill).
resource "aws_s3_object" "kb_guidance" {
  bucket = module.foundation.assets_bucket
  key    = "knowledge-base/reconciliation-guidance.md"
  source = "${path.root}/../../../data/kb-seed/reconciliation-guidance.md"
  etag   = filemd5("${path.root}/../../../data/kb-seed/reconciliation-guidance.md")
}

# Uploading the seed objects does NOT make them searchable — the KB's vector index only
# reflects the S3 prefix after a Bedrock ingestion job runs. Without this, consult-guidance
# silently returns nothing on a from-scratch deploy until someone notices and clicks "Sync" in
# the console. Re-run on every seed-content change and block the apply until it finishes, so a
# single `terraform apply` leaves the KB actually queryable.
resource "null_resource" "kb_ingestion" {
  triggers = {
    kb_seed_etag     = aws_s3_object.kb_seed.etag
    kb_guidance_etag = aws_s3_object.kb_guidance.etag
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      JOB_ID=$(aws bedrock-agent start-ingestion-job \
        --knowledge-base-id ${module.recon_agent.kb_id} \
        --data-source-id ${module.recon_agent.kb_data_source_id} \
        --region ${var.region} --query 'ingestionJob.ingestionJobId' --output text)
      echo "KB ingestion job: $JOB_ID"
      for i in $(seq 1 60); do
        STATUS=$(aws bedrock-agent get-ingestion-job \
          --knowledge-base-id ${module.recon_agent.kb_id} \
          --data-source-id ${module.recon_agent.kb_data_source_id} \
          --ingestion-job-id "$JOB_ID" --region ${var.region} \
          --query 'ingestionJob.status' --output text)
        echo "  status: $STATUS"
        case "$STATUS" in
          COMPLETE) exit 0 ;;
          FAILED) exit 1 ;;
        esac
        sleep 10
      done
      exit 1
    EOT
  }
}

# Seed the editable skills/ prefix and system-prompt from the repo. These are the live source
# the BFF skills manager and the agent read at runtime; edits via the UI overwrite them in
# place (no redeploy). Managed with lifecycle ignore so UI edits are not reverted on the
# next apply — seeding is first-write only.
resource "aws_s3_object" "skill_seed" {
  for_each = fileset("${path.root}/../../../agent-blueprint/recon-agent/skills", "*.md")

  bucket = module.foundation.assets_bucket
  # Directory-per-skill layout: skills/<name>/SKILL.md. The AgentCore Harness requires a dir per
  # skill; the container loader reads any .md under the prefix recursively, so both paths work.
  key          = "skills/${trimsuffix(each.value, ".md")}/SKILL.md"
  source       = "${path.root}/../../../agent-blueprint/recon-agent/skills/${each.value}"
  etag         = filemd5("${path.root}/../../../agent-blueprint/recon-agent/skills/${each.value}")
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source]
  }
}

# One-time migration of the FLAT layout (skills/<name>.md) to nested (skills/<name>/SKILL.md),
# preserving any live UI edits: copy each flat object to its nested key only if the nested key
# does not already exist (so the seed's first-write / a UI edit wins), then delete the flat
# object. Idempotent — after the flat objects are gone it is a no-op. Runs on every apply but
# exits fast once migrated.
resource "terraform_data" "skills_layout_migration" {
  triggers_replace = { bucket = module.foundation.assets_bucket }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      BUCKET='${module.foundation.assets_bucket}'
      REGION='${var.region}'
      # List flat skill objects (skills/<name>.md, NOT skills/<name>/SKILL.md).
      FLAT=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix skills/ --region "$REGION" \
        --query "Contents[?ends_with(Key, '.md') && !contains(Key, '/SKILL.md')].Key" \
        --output text 2>/dev/null || true)
      for KEY in $FLAT; do
        NAME=$(basename "$KEY" .md)
        NESTED="skills/$NAME/SKILL.md"
        if ! aws s3api head-object --bucket "$BUCKET" --key "$NESTED" --region "$REGION" >/dev/null 2>&1; then
          echo "[skills-migration] $KEY -> $NESTED"
          aws s3 cp "s3://$BUCKET/$KEY" "s3://$BUCKET/$NESTED" --region "$REGION" >/dev/null
        fi
        aws s3 rm "s3://$BUCKET/$KEY" --region "$REGION" >/dev/null
      done
    EOT
  }

  depends_on = [aws_s3_object.skill_seed]
}

# The SHARED policy core. Read by the runtime container AND by the harness worker (which appends
# the contract object above), and rewritten in place by the UI prompt editor and by deploying a
# config version — so there is exactly one artifact holding the agent's instructions.
resource "aws_s3_object" "system_prompt_seed" {
  bucket       = module.foundation.assets_bucket
  key          = "system-prompt.md"
  source       = "${path.root}/../../../agent-blueprint/recon-agent/system-prompt.md"
  etag         = filemd5("${path.root}/../../../agent-blueprint/recon-agent/system-prompt.md")
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source]
  }
}

# Publish the deterministic Tier-1 Lambda source for the Config tab's READ-ONLY viewer. Unlike
# skills, this is not editable in the UI, so it is NOT lifecycle-ignored — it tracks the repo and
# re-syncs on every apply so the viewer always shows the code that is actually deployed.
resource "aws_s3_object" "tier1_source" {
  for_each = toset(["handler.py", "engine.py", "matchers.py", "config.py"])

  bucket       = module.foundation.assets_bucket
  key          = "lambda-src/tier1/${each.value}"
  source       = "${path.root}/../../../backend/tier1/${each.value}"
  etag         = filemd5("${path.root}/../../../backend/tier1/${each.value}")
  content_type = "text/x-python"
}

# Publish the Tier-2 container agent source for the Config tab's READ-ONLY viewer (shown when the
# Runtime backend is selected). Tracks the repo and re-syncs each apply — the top-level agent
# modules that make up the Strands agentic loop.
resource "aws_s3_object" "agent_source" {
  for_each = toset([
    "agent.py", "strands_investigator.py", "llm.py", "classifier.py",
    "proposal.py", "skills_loader.py", "gateway_mcp.py",
  ])

  bucket       = module.foundation.assets_bucket
  key          = "lambda-src/agent/${each.value}"
  source       = "${path.root}/../../../agent-blueprint/recon-agent/${each.value}"
  etag         = filemd5("${path.root}/../../../agent-blueprint/recon-agent/${each.value}")
  content_type = "text/x-python"
}

# Microsoft Graph tool on the recon Gateway — live SharePoint/Outlook/OneDrive lookups for the
# consult-guidance skill. enabled-gated: a no-op until Entra creds are provided.
module "graph" {
  source        = "../../modules/microsoft-graph-obo"
  project_name  = var.name_prefix
  environment   = "dev"
  aws_region    = var.region
  enabled       = var.graph_enabled
  gateway_id    = module.recon_agent.gateway_id
  tenant_id     = var.entra_tenant_id
  client_id     = var.entra_client_id
  client_secret = var.entra_client_secret
  # The recon gateway's INBOUND auth is Cognito JWT, not Entra — OBO's default token-exchange
  # can't swap a token Entra didn't issue. App-only (client_credentials) is the only mode
  # compatible with a non-Entra-fronted gateway.
  auth_mode = "client_credentials"
}

# IDP push entry point: hook Lambda that maps IDP-completed documents to ReconItems via the
# normal intake path. IDP-side registration of its ARN is separate config (out of scope).
module "idp_hook" {
  source = "../../modules/idp-hook"

  name_prefix            = var.name_prefix
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  items_table            = module.foundation.items_table
  items_table_arn        = module.foundation.items_table_arn
  recon_domain           = var.recon_domain
  assets_bucket          = module.foundation.assets_bucket
  assets_bucket_arn      = module.foundation.assets_bucket_arn
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs

  # Reprocess re-drive: a NEW IDP run of an already-ingested document re-opens + re-investigates
  # its case (see the IDP reprocess/re-drive design record).
  cases_table               = module.foundation.cases_table
  cases_table_arn           = module.foundation.cases_table_arn
  audit_table               = module.foundation.audit_table
  audit_table_arn           = module.foundation.audit_table_arn
  agent_worker_function_arn = module.tier1.worker_function_arn
  agent_runtime_arn         = module.recon_agent.runtime_arn
  reprocess_cap             = var.reprocess_cap
}

# Mocked general ledger (S3 + Athena) backing the deterministic Tier-1 lookup and the
# `general-ledger` Gateway tool.
module "gl_mock" {
  source = "../../modules/gl-mock"

  name_prefix            = var.name_prefix
  assets_bucket          = module.foundation.assets_bucket
  assets_bucket_arn      = module.foundation.assets_bucket_arn
  gl_data_dir            = "${path.root}/../../../data/general-ledger"
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs

  # set_draw_status server-side gates (provenance + threshold re-check) on the autonomous path.
}
