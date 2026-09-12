####################################################################################
# Recon platform — dev environment root. Wires the platform modules together.
# Terraform is the sole deploy mechanism for 100% of the platform.
####################################################################################

data "aws_caller_identity" "current" {}

# Single shared Lambda deployment package. Every Python Lambda (intake, tier1, idp-hook,
# api BFFs, and the deal pipeline's parser and mock OMS upload when enabled) imports the backend
# as `from backend....`, so the zip must contain a top-level backend/ package. This module builds
# it once; the Lambda modules reference the same zip.
#
# runtime_dependencies is spelled out here rather than defaulted in the module, because ONE zip
# serves every Lambda this root deploys (see the module's variables.tf): the list has to be the
# union of what all of them import.
#   pydantic          backend/intake, recon_core -- the ReconItem model and every payload schema.
#   PyYAML            backend/recon_core/skill_meta.py parses SKILL.md frontmatter as real YAML.
#   extract-msg,
#   reportlab         backend/email_preprocess reads Outlook .msg containers and renders bodies to
#                     PDF, because neither upload destination can read an email.
#   red-black-tree-mod  imported by nothing here. extract-msg depends on it and it is published as a
#                     source distribution only, which the platform-pinned pip in stage.sh cannot
#                     install; stage.sh builds a wheel for any LISTED requirement that lacks one, so
#                     a transitive sdist-only package has to be named to be reachable. Pinned inside
#                     extract-msg 0.56.1's own >=1.20,<=1.23 range.
#   tzdata            backend/deal_pipeline: the IANA database Python's zoneinfo falls back to when
#                     the Lambda image ships none, so Date Arrived is computed in the desk time zone
#                     rather than silently in UTC. Harmless for the recon Lambdas.
#
# ⚠️ This list is DUPLICATED in .gitlab-ci.yml's pre-plan stage.sh call and the two must agree:
# archive_file reads the staging directory at PLAN time, so whatever CI staged is what ships, and
# terraform_data.stage's hash will already match at apply and not re-stage to correct it.
module "lambda_package" {
  source      = "../../modules/lambda-package"
  backend_dir = "${path.root}/../../../backend"
  runtime_dependencies = [
    "pydantic==2.13.0",
    "PyYAML==6.0.3",
    "extract-msg==0.56.1",
    "reportlab==5.0.1",
    "red-black-tree-mod==1.22",
    "tzdata==2026.3",
  ]
}

# The deal-pipeline app's own resources (bucket, tables, memories, parser + mock OMS Lambdas),
# composed beside the recon platform so the console serves both apps behind one app rail. Off by
# default: an existing recon deployment is unchanged until an operator flips enable_deal_pipeline.
#
# name_prefix is "<recon prefix>-pipeline", NOT the design doc's "deal-pipeline-dev": the pipeline's
# bucket, tables and parameter then read as this environment's beside the recon ones, and a
# `deal-pipeline-dev-*` deployment that predates the composition (or belongs to another checkout)
# in the same account cannot collide with them. This is also the prefix the deployed environment
# already carries, so it must not change.
#
# The module reads region and account from its own data sources, so neither is passed. The zip is
# the shared one above (its tzdata entry is what the parser needs). content_root is spelled out
# rather than left to the module default so a reader sees where the S3 seeds come from.
module "deal_pipeline" {
  count  = var.enable_deal_pipeline ? 1 : 0
  source = "../../modules/deal-pipeline"

  name_prefix     = "${var.name_prefix}-pipeline"
  agent_model_id  = var.pipeline_agent_model_id
  memory_model_id = var.pipeline_memory_model_id

  lambda_zip         = module.lambda_package.zip_path
  lambda_source_hash = module.lambda_package.source_code_hash

  content_root = "${path.root}/../../.."
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
  # aws_lambda_invocation.cognito_callbacks below, once the frontend distribution exists — same
  # post-hoc pattern the reference repo uses for its OAuth callback registration. One apply.
}

# Console-wide settings: one SSM String parameter per setting under /<name_prefix>/console, seeded
# from the same variables that feed the task's environment below and then owned by the console's
# Settings screen (the module ignores value changes, so an apply never reverts an operator's edit).
# Always on, unlike the pipeline: the layer sits above both apps, and a recon-only console uses it
# to store its own access groups. The pipeline's model id doubles as the console default an app may
# inherit; the pipeline's own parameter (/<name_prefix>-pipeline/agent-model-id) is untouched and
# still owned by its Config tab. A parameter whose seed is blank is NOT created -- the UI creates it
# on first save -- so a fresh recon-only deployment with no groups named creates the enablement
# flag and the two defaults only. The task role's grant on the prefix is built by the frontend
# module from the same string, which is why the prefix is passed as this module's output.
module "console_settings" {
  source = "../../modules/console-settings"

  prefix = "/${var.name_prefix}/console"

  recon_access_group    = var.recon_access_group
  recon_admin_group     = var.recon_admin_group
  pipeline_access_group = var.pipeline_access_group
  pipeline_admin_group  = var.pipeline_admin_group
  pipeline_enabled      = var.enable_deal_pipeline
  default_model_id      = var.pipeline_agent_model_id
  organization_label    = var.console_organization_label
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

  # Who may change platform configuration. Empty means nobody — see the variable's own note.
  recon_admin_group = var.recon_admin_group
  auth_groups_claim = var.auth_groups_claim

  # Per-app access behind the app rail (chatbot-app/frontend/src/lib/auth/apps.ts). In a recon-only
  # console an access group of "" is open to every authenticated user, which is what this deployment
  # had before the rail. With enable_deal_pipeline both groups are required -- validated on that
  # variable here and again on pipeline_enabled inside the module -- and the module tells the console
  # to fail closed on a blank one (REQUIRE_ACCESS_GROUPS). The pipeline admin group fails closed like
  # recon_admin_group.
  recon_access_group    = var.recon_access_group
  pipeline_access_group = var.pipeline_access_group
  pipeline_admin_group  = var.pipeline_admin_group

  # Console-wide settings layer (module.console_settings above). The prefix is the module's output
  # rather than the same string spelled twice, so the parameters Terraform seeds and the path the
  # console reads (and the task role's grant) cannot drift apart. The admin group is environment-only
  # by contract; the label is the default shown until an operator stores one.
  console_settings_prefix    = module.console_settings.prefix
  console_admin_group        = var.console_admin_group
  console_organization_label = var.console_organization_label

  # Deal-pipeline app wiring. The module exports the environment its BFF reads and the task-role
  # grants on its resources (console_environment, console_task_statements), so the console module
  # knows apps only in the abstract. try(..., []) because module.deal_pipeline is count-gated: with
  # the app off there is no instance to index, and an empty list wires nothing. pipeline_enabled is
  # the console-level switch (PIPELINE_ENABLED, REQUIRE_ACCESS_GROUPS); both come from the one
  # variable so they cannot disagree.
  pipeline_enabled = var.enable_deal_pipeline
  app_wiring = {
    pipeline = {
      enabled         = var.enable_deal_pipeline
      environment     = try(module.deal_pipeline[0].console_environment, [])
      task_statements = try(module.deal_pipeline[0].console_task_statements, [])
    }
  }

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
  # No recipient address is configured here. The BFF resolves the draft's recipient_contact_id
  # against the contacts table at send time, so a deactivated contact stops being sendable at once.
  graph_mailbox      = var.graph_mailbox
  egress_gateway_url = module.recon_agent.gateway_url
  reprocess_cap      = var.reprocess_cap
  # Config tab -> Contacts/Templates: the only role in the system that WRITES these two tables.
  contacts_table      = module.contact_store.contacts_table_name
  contacts_table_arn  = module.contact_store.contacts_table_arn
  templates_table     = module.contact_store.templates_table_name
  templates_table_arn = module.contact_store.templates_table_arn
  # Config tab -> Workflow types: what may be uploaded, and whether each kind is extracted or
  # ingested as knowledge. Same posture as the two tables above -- the BFF is the only writer.
  workflow_types_table     = module.workflow_types.workflow_types_table_name
  workflow_types_table_arn = module.workflow_types.workflow_types_table_arn
  # Documents tab -> the document pipeline's own API. A read path only, and one this deployment can
  # add on its own: the grant is identity-side on recon's task role, so nothing in the pipeline's
  # account or state changes.
  idp_appsync_endpoint = var.idp_appsync_endpoint
  idp_appsync_api_arn  = var.idp_appsync_api_arn
  # The same tab's extracted fields. Recon's OWN table, so unlike the two above this needs no grant on
  # anyone else's API and no variable in `terraform.tfvars` -- which also means CI cannot drift on it,
  # the way a hand-copied `RECON_TFVARS` key can. The grant the module builds from this is read-only;
  # the notices table is what the matcher and the interceptor read, and a display tab must not be able
  # to change it.
  notices_table     = module.notice_store.notices_table_name
  notices_table_arn = module.notice_store.notices_table_arn
  # Documents tab -> Upload. The audit table is recon's own record of what it sent, and it is what the
  # tab reads back -- which is why nothing here grants a read on either destination bucket. The
  # PutObject into the pipeline's input bucket is identity-side too while both live in this account; a
  # cross-account pipeline would additionally need a resource policy on their side.
  uploads_table                  = module.upload_audit.uploads_table_name
  uploads_table_arn              = module.upload_audit.uploads_table_arn
  uploads_table_index_arn        = module.upload_audit.uploads_table_index_arn
  idp_input_bucket               = var.idp_input_bucket
  idp_input_bucket_arn           = var.idp_input_bucket_arn
  email_preprocess_function_name = module.email_preprocess.function_name
  email_preprocess_function_arn  = module.email_preprocess.function_arn
  # Lessons -> AgentCore Memory feed (agent recalls them on future similar items).
  recon_memory_id   = module.recon_agent.memory_id
  recon_memory_arn  = module.recon_agent.memory_arn
  agent_runtime_arn = module.recon_agent.runtime_arn
  # Reject→reprocess re-drives the agent via the agent-worker Lambda (backend switch honored);
  # approve executes the persisted proposed_action THROUGH the gateway's set_draw_status tool.
  agent_worker_function_arn = module.tier1.worker_function_arn
  # Queue → "Create New": manual payload submission goes through the intake Lambda, so it lands in
  # the items table exactly like an IDP-fed item and Tier-1 picks it up off the DynamoDB Stream.
  intake_function_name = module.intake.function_name
  intake_function_arn  = module.intake.function_arn
  # Config tab → Policy: rewrite the gated Cedar statements' threshold on change.
  policy_engine_name = module.recon_agent.policy_engine_name
  egress_gateway_arn = module.recon_agent.gateway_arn

  # Config tab: deterministic Tier-1 toggle + auto-resolve threshold.
  tier1_enabled_param = module.foundation.tier1_enabled_param
  auto_resolve_param  = module.foundation.auto_resolve_param

  comment_requirement_param = module.foundation.comment_requirement_param

  # Config tab backend + model selectors, and the Evals tab (config-version pointer + eval/harness
  # log groups).
  agent_backend_param           = module.foundation.agent_backend_param
  agent_model_id_param          = module.foundation.agent_model_id_param
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

# The apply-time actor: readiness waits and one-shot API calls that have no declarative form.
# Deliberately dependency-free so its zip needs no pip — see the module header.
module "deploy_actions" {
  source = "../../modules/deploy-actions"

  name_prefix = var.name_prefix
  # Scoped to the one pool whose SPA client gets patched below. UpdateUserPoolClient REPLACES a
  # client's configuration, so this grant is deliberately not broader.
  user_pool_arn     = module.foundation.user_pool_arn
  assets_bucket_arn = module.foundation.assets_bucket_arn
  # The pipeline's bucket too, when that app is deployed: its create-only seeds republish through
  # the same reconciliation (aws_lambda_invocation.pipeline_seed_push below). try() rather than a
  # conditional because module.deal_pipeline has no instance to index when the app is off; with the
  # app off the list is empty and the module renders the policy it always has.
  additional_assets_bucket_arns = try([module.deal_pipeline[0].assets_bucket_arn], [])
}

# Patch the Cognito SPA client's OAuth callback/logout URLs to the CloudFront domain after the
# frontend distribution is up. Breaks the foundation<->frontend cycle (depends only forward).
#
# Was a local-exec AWS CLI call. The argument list matters and is re-sent in full by the handler:
# UpdateUserPoolClient REPLACES the client's configuration rather than merging, so dropping the auth
# flows or supported providers would silently strip them from a working client.
# Forget the retired CLI shim. It has no destroy provisioner, so nothing is torn down either way;
# `destroy = false` keeps it out of the plan's DELETE list, which the CI destroy guard matches
# exactly and would otherwise gate behind the manual allow-destroy job for a no-op.
removed {
  from = null_resource.cognito_callbacks

  lifecycle {
    destroy = false
  }
}

resource "aws_lambda_invocation" "cognito_callbacks" {
  function_name = module.deploy_actions.function_name

  input = jsonencode({
    action        = "patch_cognito_callbacks"
    user_pool_id  = module.foundation.user_pool_id
    client_id     = module.foundation.spa_client_id
    callback_urls = ["https://${module.frontend.distribution_domain}/callback"]
    logout_urls   = ["https://${module.frontend.distribution_domain}/"]
    # Re-run when the actor's code changes, not only when the domain or client id does.
    handler_version = module.deploy_actions.source_code_hash
  })
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
  # An ID, not an address: the worker resolves it against the contacts table on each send, so
  # deactivating this contact stops the resolution email on the very next case.
  notify_contact_id  = module.contact_store.notify_contact_id
  contacts_table     = module.contact_store.contacts_table_name
  contacts_table_arn = module.contact_store.contacts_table_arn

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
  agent_model_id_param         = module.foundation.agent_model_id_param

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

  workflow_types_table     = module.workflow_types.workflow_types_table_name
  workflow_types_table_arn = module.workflow_types.workflow_types_table_arn
}

module "recon_agent" {
  source = "../../modules/recon-agent"

  # Apply-time readiness waits (managed-KB data source, managed-kb connector target) run in the
  # deploy-actions Lambda rather than a local-exec AWS CLI poll.
  deploy_actions_function_name    = module.deploy_actions.function_name
  deploy_actions_source_code_hash = module.deploy_actions.source_code_hash

  name_prefix     = var.name_prefix
  region          = var.region
  agent_src_dir   = "${path.root}/../../../agent-blueprint/recon-agent"
  cases_table     = module.foundation.cases_table
  cases_table_arn = module.foundation.cases_table_arn
  audit_table     = module.foundation.audit_table
  audit_table_arn = module.foundation.audit_table_arn
  # The interceptor's extraction-confidence guard resolves the notice a proposal cited.
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

  # Counterparty-email recipient allowlist. This module is the ONLY consumer: the allowlist is a gate,
  # and the gateway request interceptor is the gate. It is deliberately NOT passed to frontend-ecs --
  # a BFF copy could only ever agree with this one or be wrong, and it read as a blocked save.
  counterparty_email_domains = var.counterparty_email_domains

  # Same baggage allow-list as the Lambda + harness, so the runtime backend's spans carry
  # recon.item_id / recon.domain / recon.backend too.
  otel_baggage_span_attribute_keys = local.otel_baggage_span_attribute_keys

  # Email human-confirmation gate: the interceptor + the platform send paths share this token;
  # the agent runtime container also gets it (only platform code notify.py injects it — the model
  # never reads env), but the model's own counterparty-email tool call carries no token → blocked.
  email_confirmation_token = random_password.email_confirmation.result

  # Gateway Lambda tools (recon-status + correspondence-search from the shared zip;
  # general-ledger and set-draw-status from gl-mock). The knowledge-base read is NOT a Lambda —
  # it is the `managed-kb` connector target the Gateway calls Bedrock for directly.
  lambda_zip         = module.lambda_package.zip_path
  lambda_source_hash = module.lambda_package.source_code_hash
  gl_tool_lambda_arn = module.gl_mock.function_arn
  gl_tool_enabled    = true
  # The ACTUAL side: extracted counterparty notices. Read-only — there is no notices write tool.
  notice_tool_lambda_arn = module.notice_store.notice_tool_lambda_arn
  notice_tool_enabled    = true
  # Write tool: the agent (when confident) + human-approve path set draw/ledger status here.
  set_draw_status_lambda_arn = module.gl_mock.write_function_arn
  set_draw_status_enabled    = true
  vpc_subnet_ids             = local.vpc_subnets
  vpc_security_group_ids     = local.vpc_sgs

  # Auto-resolve (straight-through processing): threshold param + lesson ledger + email.
  auto_resolve_param     = module.foundation.auto_resolve_param
  auto_resolve_param_arn = module.foundation.auto_resolve_param_arn
  # Config tab: the live model selection this container reads per invocation, with `model_id` below
  # remaining the fallback.
  agent_model_id_param     = module.foundation.agent_model_id_param
  agent_model_id_param_arn = module.foundation.agent_model_id_param_arn
  lessons_table            = module.foundation.lessons_table
  lessons_table_arn        = module.foundation.lessons_table_arn
  # Shared mailbox the agent's Microsoft Graph email tools send from / read (GRAPH_MAILBOX).
  graph_mailbox = var.graph_mailbox

  # Contacts + templates: the two read-only gateway targets the model picks a recipient and a
  # wording from, and the contacts table the interceptor checks a send against. The notification
  # contact ID goes to the runtime's auto-resolve path -- again an ID, never an address.
  contact_tool_lambda_arn = module.contact_store.contact_tool_lambda_arn
  contact_tool_enabled    = true
  contacts_table          = module.contact_store.contacts_table_name
  contacts_table_arn      = module.contact_store.contacts_table_arn
  notify_contact_id       = module.contact_store.notify_contact_id

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
  # Same baggage allow-list as the harness, so both backends' spans carry the same recon attributes.
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
  # The UI-editable S3 seeds: bucket key => repo file that seeds it.
  #
  # ONE definition feeding two consumers — the `aws_s3_object` seeds below (first write only) and
  # `aws_lambda_invocation.seed_push` (every apply, unless the live object was edited). Adding a skill file
  # is now a single change; before this, a new skill could be seeded but never pushed, or pushed but
  # never seeded, and neither shows up as an error.
  editable_seeds = merge(
    {
      "system-prompt.md"         = "${path.root}/../../../agent-blueprint/recon-agent/system-prompt.md"
      "system-prompt-harness.md" = "${path.root}/../../../agent-blueprint/recon-agent-harness/system-prompt.md"
    },
    {
      # Directory-per-skill layout: skills/<name>/SKILL.md, which the AgentCore Harness requires.
      # The container loader reads any .md under the prefix recursively, so both paths work.
      for f in fileset("${path.root}/../../../agent-blueprint/recon-agent/skills", "*.md") :
      "skills/${trimsuffix(f, ".md")}/SKILL.md" => "${path.root}/../../../agent-blueprint/recon-agent/skills/${f}"
    },
  )
}

# Seed the harness's CALLING CONTRACT to S3 (submit_proposal fields + prefixed gateway tool
# names). This is appended after the shared policy core in system_prompt_seed below — the policy
# itself is NOT duplicated here, so the two backends cannot drift apart. Create-only like the other
# editable objects (modules/seeded-object, create_only = true: first write only, and the module's
# header explains why it ignores more than etag/source), so this writes the object once and never
# overwrites the live text — but repo edits do NOT need a manual `aws s3 cp`:
# `aws_lambda_invocation.seed_push` below re-pushes every changed `local.editable_seeds` entry on
# each apply, and fails the apply on a two-sided conflict. (This comment claimed the opposite until
# 2026-09-04 and misled a planning pass.)
module "harness_system_prompt_seed" {
  source = "../../modules/seeded-object"

  bucket       = module.foundation.assets_bucket
  key          = "system-prompt-harness.md"
  source_path  = local.editable_seeds["system-prompt-harness.md"]
  content_type = "text/markdown"
  create_only  = true
}

moved {
  from = aws_s3_object.harness_system_prompt_seed
  to   = module.harness_system_prompt_seed.aws_s3_object.create_only[0]
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

  # Deliver runtime TRACES to CloudWatch so the online eval config can score
  # runtime-backend sessions (account-level Transaction Search enabled 2026-07-27).
  enable_xray_traces = true
}

# Upload the KB seed corpus to the assets bucket's knowledge-base/ prefix.
#
# The corpus is a directory tree, not two files: playbooks/ holds the reconciliation
# methodology, retrieved_emails/ holds archived correspondence (HTML bodies plus PDF and
# spreadsheet attachments), and every document has a sibling <name>.<ext>.metadata.json sidecar
# carrying the attributes the agent filters on. 14 documents + 14 sidecars = 28 objects.
# tests/kb_seed/ is the contract for that shape.
locals {
  kb_seed_dir = "${path.root}/../../../data/kb-seed"

  # S3 defaults an unknown extension to binary/octet-stream, and Bedrock chooses its document
  # parser from the object's content type. A .pdf or .xlsx uploaded as octet-stream still
  # *ingests*: it is indexed with no extractable text, stays retrievable, and reports nothing
  # wrong anywhere -- the agent just cites a document that contains no evidence.
  kb_seed_content_types = {
    ".md"   = "text/markdown"
    ".html" = "text/html"
    ".pdf"  = "application/pdf"
    ".xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ".json" = "application/json" # the .metadata.json sidecars
  }
}

resource "aws_s3_object" "kb_seed" {
  # "**" walks the whole tree, so both subdirectories and the sidecars are picked up.
  for_each = fileset(local.kb_seed_dir, "**")

  bucket = module.foundation.assets_bucket
  key    = "knowledge-base/${each.value}"
  source = "${local.kb_seed_dir}/${each.value}"
  etag   = filemd5("${local.kb_seed_dir}/${each.value}")

  # Indexing the map directly (rather than lookup() with a default) is deliberate: a new format
  # added to the corpus must fail the plan so the content type is a decision, not a default.
  # regex() returns the LAST extension, which is what lets notice.pdf and notice.pdf.metadata.json
  # coexist in one folder -- the sidecar maps to .json, the document to .pdf.
  content_type = local.kb_seed_content_types[regex("\\.[^.]+$", each.value)]
}

# (knowledge base, data source) pairs the corpus is ingested into.
#
# ⚠️ ONLY a managed KB, and do not add an **S3 Vectors**-backed one beside it. This corpus violates
# two of S3 Vectors' hard limits (verified live 2026-08-26, job CH0ZJE8F5D):
#
#   1. sidecar FILE size limit of 1024 bytes -- "Ignored 8 files as the associated metadata was
#      larger than service limit of MaximumFileSizeSupported: 1024 bytes". All 8
#      retrieved_emails/*.metadata.json exceed it (1149-1217 bytes even minified: the
#      {"value":{"type":...},"includeForEmbedding":...} envelope costs ~70 bytes per attribute and
#      an email carries 10). Those documents are ignored OUTRIGHT -- they never appear in
#      ListKnowledgeBaseDocuments, not even as FAILED.
#   2. "Filterable metadata must have at most 2048 bytes (Service: S3Vectors, Status Code: 400)" --
#      4 of the 7 playbooks hard-FAIL. This one has no observable discriminator: two playbooks with
#      IDENTICAL metadata land on opposite sides of it, and the failing set's sizes (522-575 bytes)
#      overlap the passing set's exactly. Do not try to reason it out from sidecar size.
#
# The managed KB has neither limit -- it indexes every document in the corpus, sidecars of 1610-1660
# bytes included. So the metadata design and an S3 Vectors index are mutually exclusive: supporting
# one would mean gutting the attribute set corpus-wide, degrading the retrieval filtering that is
# the whole point of the sidecars. Keep this note -- it is the reason not to try.
locals {
  kb_ingest_targets = {
    managed = {
      kb_id = module.recon_agent.managed_kb_id
      ds_id = module.recon_agent.managed_kb_data_source_id
    }
  }
}

# Uploading the seed objects does NOT make them searchable — a KB's index only reflects the S3
# prefix after a Bedrock ingestion job runs. Without this, consult-guidance silently returns
# nothing on a from-scratch deploy until someone notices and clicks "Sync" in the console.
# Re-run on every seed-content change and block the apply until it finishes, so a single
# `terraform apply` leaves the KB actually queryable.
#
# ⚠️ This resource is load-bearing, not tidiness. Creating a KB does not start an ingestion job:
# S3 objects are ingested only by an explicit StartIngestionJob. A managed KB left un-ingested is
# created EMPTY, its connector target still validates and reports READY, tools/list still advertises
# the filter parameters, and every retrieval returns an empty retrievalResults with no error
# anywhere. The whole feature reads as "filters work — everything matches nothing".
#
# The for_each stays despite there being one target, because the state addresses are already keyed;
# collapsing it to a bare resource would destroy and re-create the managed ingestion for nothing.
resource "aws_lambda_invocation" "kb_ingestion" {
  for_each = local.kb_ingest_targets

  function_name = module.deploy_actions.function_name

  input = jsonencode({
    action            = "start_kb_ingestion"
    knowledge_base_id = each.value.kb_id
    data_source_id    = each.value.ds_id
    # Hash over every object's etag, so adding, editing or removing any document in the corpus
    # re-ingests. Not read by the handler — its only job is to make the invocation's input change.
    corpus = sha256(join(",", [for object in aws_s3_object.kb_seed : object.etag]))
    # Re-run when the actor's code changes, not only when the corpus does.
    handler_version = module.deploy_actions.source_code_hash
  })
}

# ⚠️ The document counts the handler returns are apply-time EVIDENCE that the corpus landed, and
# they are not redundant with the job status: a job can report COMPLETE with a non-zero failed
# count, and a managed-KB job has been observed dropping 5 documents while reporting 0 failed.
# Surfaced as an output so they appear in the apply log the way the provisioner's echo used to.
# If the numbers look wrong, go to ListKnowledgeBaseDocuments — a dropped document is simply ABSENT.

output "kb_ingestion_counts" {
  description = "Per-KB ingestion job id and scanned/indexed/failed document counts from this apply."
  value       = { for k, invocation in aws_lambda_invocation.kb_ingestion : k => jsondecode(invocation.result) }
}

# Forget the retired null_resource, including the stale ["vectors"] instance.
#
# Both instances are pure state entries: a null_resource with no `when = destroy` provisioner tears
# down nothing in AWS, so nothing is lost by dropping them. `destroy = false` is here to keep them
# out of the plan's DELETE list — the CI destroy guard matches `actions == ["delete"]` exactly, and
# these two no-ops would otherwise force the manual `terraform:apply:allow-destroy` job and a human
# approval for no reason. (The ["vectors"] entry has been a pending pure delete since the 2026-08-26
# apply, when S3 Vectors stopped being a key in local.kb_ingest_targets.)
removed {
  from = null_resource.kb_ingestion

  lifecycle {
    destroy = false
  }
}

# Seed the editable skills/ prefix and system-prompt from the repo. These are the live source
# the BFF skills manager and the agent read at runtime; edits via the UI overwrite them in
# place (no redeploy). modules/seeded-object with create_only = true, so UI edits are not reverted
# on the next apply — seeding is first-write only, and the module ignores every attribute whose
# drift the provider would resolve by re-uploading the repo file, not just etag/source as the
# inline resource this replaced did (an application write that only set a charset could have
# reverted a skill).
# The key => file map lives in local.editable_seeds so the deploy-time push (aws_lambda_invocation.seed_push)
# cannot drift from what is seeded here.
module "skill_seed" {
  source = "../../modules/seeded-object"
  # Keyed on the FILE NAME, matching the `fileset()` keys the inline resource always had, so the
  # `moved` blocks below map each live object one-to-one. Re-keying on the bucket key would destroy
  # and recreate all seven objects.
  for_each = {
    for k, f in local.editable_seeds : basename(f) => { key = k, source = f }
    if startswith(k, "skills/")
  }

  bucket       = module.foundation.assets_bucket
  key          = each.value.key
  source_path  = each.value.source
  content_type = "text/markdown"
  create_only  = true
}

# State-only moves of the seven skill objects from the inline aws_s3_object.skill_seed they were
# declared as until 2026-09: one per instance, same key on both sides, same bucket, key, source and
# content type on the other side, so a plan shows seven moves and no create, destroy or replace. A
# skill file added later needs no entry; a `from` with nothing in state is a no-op.
moved {
  from = aws_s3_object.skill_seed["consult-guidance.md"]
  to   = module.skill_seed["consult-guidance.md"].aws_s3_object.create_only[0]
}

moved {
  from = aws_s3_object.skill_seed["correspondence-search.md"]
  to   = module.skill_seed["correspondence-search.md"].aws_s3_object.create_only[0]
}

moved {
  from = aws_s3_object.skill_seed["counterparty-contact-draft.md"]
  to   = module.skill_seed["counterparty-contact-draft.md"].aws_s3_object.create_only[0]
}

moved {
  from = aws_s3_object.skill_seed["document-cross-reference.md"]
  to   = module.skill_seed["document-cross-reference.md"].aws_s3_object.create_only[0]
}

moved {
  from = aws_s3_object.skill_seed["ledger-status-resolution.md"]
  to   = module.skill_seed["ledger-status-resolution.md"].aws_s3_object.create_only[0]
}

moved {
  from = aws_s3_object.skill_seed["record-match-review.md"]
  to   = module.skill_seed["record-match-review.md"].aws_s3_object.create_only[0]
}

moved {
  from = aws_s3_object.skill_seed["unknown.md"]
  to   = module.skill_seed["unknown.md"].aws_s3_object.create_only[0]
}


# The one-time flat -> nested skills migration (skills/<name>.md -> skills/<name>/SKILL.md) is DONE
# and its resource is deleted rather than ported to the deploy-actions Lambda.
#
# Verified against the live bucket on 2026-09-02: every object under skills/ is already a nested
# SKILL.md and no flat <name>.md remains, so the provisioner had become a permanent no-op that still
# shelled out to `aws s3api list-objects-v2` on every apply. Porting a no-op would have moved the
# dependency without removing the work.
#
# ⚠️ If a flat object ever reappears (an old checkout applying an earlier revision), the seed
# resources above create the NESTED key and the flat one is simply ignored — it is not read by
# anything. The migration was only needed to preserve UI edits made under the old layout, and there
# are none left to preserve.
removed {
  from = terraform_data.skills_layout_migration

  lifecycle {
    destroy = false
  }
}

# Push repo edits to the create-only seeds above, UNLESS the live object was edited in this
# environment. The seeds are `ignore_changes`d because the UI rewrites them in place, which until now
# meant a repo edit to a prompt or a skill never reached S3 through an apply at all: the apply was
# green and the deployed agent kept the old instructions.
#
# The decision (and every failure message) lives in the committed script, not here, because it has a
# second caller: an operator reconciling a conflict runs the same script by hand.
#
# ⚠️ This resource can FAIL the apply, by design. If a repo file AND the live object have both changed
# since the last push, no rule resolves that without a human, so it stops and names every stuck key
# with the two commands that fix it. A UI edit on its own is not a conflict — it wins silently.
resource "aws_lambda_invocation" "seed_push" {
  function_name = module.deploy_actions.function_name

  input = jsonencode({
    action = "push_editable_seeds"
    bucket = module.foundation.assets_bucket
    # ⚠️ The CONTENT travels in the payload, not a path: the actor has no repo checkout. That also
    # makes the input change whenever a seed changes, which is what re-runs the reconciliation —
    # the retired provisioner used a `filemd5` trigger for exactly that. `source` is carried only so
    # a conflict message can name the repo file an operator has to reconcile.
    #
    # ~40 KB across all seeds today, against Lambda's 6 MB synchronous payload limit. If the corpus
    # ever approaches that, stage the content in S3 and pass keys instead.
    seeds = {
      for k, f in local.editable_seeds : k => {
        content = file(f)
        source  = f
      }
    }
    handler_version = module.deploy_actions.source_code_hash
  })

  # Seeding is create-only (modules/seeded-object ignores every later change), so the objects must
  # exist before the reconciliation reads their ETags — a missing object is the "record" branch, and
  # racing it would write a marker for content the seed module is about to create.
  depends_on = [
    module.system_prompt_seed,
    module.harness_system_prompt_seed,
    module.skill_seed,
  ]
}

# Forget the retired provisioner (no destroy provisioner; `destroy = false` keeps a no-op out of the
# plan's DELETE list, which the CI destroy guard matches exactly).
removed {
  from = terraform_data.seed_push

  lifecycle {
    destroy = false
  }
}

# The same reconciliation for the deal pipeline's create-only seeds (its skills and parser prompt),
# against ITS bucket, when the app is deployed AND the operator has switched the push on. The pipeline
# module exports the key => file map it seeds from (editable_seeds), so what is seeded and what is
# pushed cannot disagree, and the deploy-actions role holds the same two grants on that bucket
# (additional_assets_bucket_arns above). The bucket is SSE-S3 like recon's, which the reconciliation
# checks before comparing anything. depends_on the whole module: the seed objects must exist before
# their ETags are read (the "record" branch), as for recon's seeds above.
#
# ⚠️ Gated on enable_pipeline_seed_push (default false), not on enable_deal_pipeline alone. The
# reconciliation's first run against a pipeline that was deployed before it existed meets objects
# with no marker; every one the UI has rewritten since (an approved skill proposal, a Skills-tab
# prompt edit) is then AMBIGUOUS and fails the apply -- after everything else in that apply has
# landed. The operator adopts those keys by hand first (output pipeline_seed_push_command), then
# flips the variable; from there this runs on every apply exactly like recon's seed_push.
resource "aws_lambda_invocation" "pipeline_seed_push" {
  count = var.enable_deal_pipeline && var.enable_pipeline_seed_push ? 1 : 0

  function_name = module.deploy_actions.function_name

  input = jsonencode({
    action = "push_editable_seeds"
    bucket = module.deal_pipeline[0].assets_bucket
    seeds = {
      for k, seed in module.deal_pipeline[0].editable_seeds : k => {
        content = file(seed.path)
        source  = seed.source
      }
    }
    handler_version = module.deploy_actions.source_code_hash
  })

  depends_on = [module.deal_pipeline]
}

# The SHARED policy core. Read by the runtime container AND by the harness worker (which appends
# the contract object above), and rewritten in place by the UI prompt editor and by deploying a
# config version — so there is exactly one artifact holding the agent's instructions.
module "system_prompt_seed" {
  source = "../../modules/seeded-object"

  bucket       = module.foundation.assets_bucket
  key          = "system-prompt.md"
  source_path  = local.editable_seeds["system-prompt.md"]
  content_type = "text/markdown"
  create_only  = true
}

moved {
  from = aws_s3_object.system_prompt_seed
  to   = module.system_prompt_seed.aws_s3_object.create_only[0]
}

# Publish the deterministic Tier-1 Lambda source for the Config tab's READ-ONLY viewer. Unlike
# skills, this is not editable in the UI, so it is NOT lifecycle-ignored — it tracks the repo and
# re-syncs on every apply so the viewer always shows the code that is actually deployed.
resource "aws_s3_object" "tier1_source" {
  for_each = toset(["handler.py", "engine.py", "matchers.py", "config.py", "classify.py"])

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

# Publish the egress-gateway REQUEST interceptor for the Config tab's READ-ONLY viewer. This is the
# code that actually refuses a ledger write (provenance + low-confidence-extraction guards), and it
# runs on EVERY tool call regardless of which tier or backend is active — so unlike the two viewers
# above it is not gated on a toggle in the UI. Tracks the repo and re-syncs each apply.
resource "aws_s3_object" "guard_source" {
  for_each = toset(["handler.py"])

  bucket       = module.foundation.assets_bucket
  key          = "lambda-src/guard/${each.value}"
  source       = "${path.root}/../../../backend/gateway_interceptor/${each.value}"
  etag         = filemd5("${path.root}/../../../backend/gateway_interceptor/${each.value}")
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

  name_prefix        = var.name_prefix
  lambda_zip         = module.lambda_package.zip_path
  lambda_source_hash = module.lambda_package.source_code_hash
  # The hook's only write target. It stores extracted documents as EVIDENCE and has no grant on
  # items, cases or audit — an extracted document must not create a case.
  notices_table     = module.notice_store.notices_table_name
  notices_table_arn = module.notice_store.notices_table_arn
  assets_bucket     = module.foundation.assets_bucket
  assets_bucket_arn = module.foundation.assets_bucket_arn
  # The completion event recon listens for. Empty by default, which creates no rule and leaves the
  # hook unreachable — so an environment with an IDP deployment MUST set this.
  idp_state_machine_arn  = var.idp_state_machine_arn
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

# Splits an uploaded .msg/.eml into documents the two destinations can read. Invoked only by the
# console's upload route -- no trigger, no schedule.
module "email_preprocess" {
  source = "../../modules/email-preprocess"

  name_prefix            = var.name_prefix
  assets_bucket          = module.foundation.assets_bucket
  assets_bucket_arn      = module.foundation.assets_bucket_arn
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

# Extracted counterparty notices — the ACTUAL side, backing the `notices` Gateway tool. Deliberately
# streamless: an extracted document is reference data and must never create a recon case.
module "notice_store" {
  source = "../../modules/notice-store"

  name_prefix            = var.name_prefix
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
}

# Who the platform may email, and in what words -- operator-maintained from the Config tab.
# Also streamless, for the same reason as notice_store: a recipient list must not create a case.
module "contact_store" {
  source = "../../modules/contact-store"

  name_prefix            = var.name_prefix
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs
  # The LAST place this variable is read. It seeds the first internal-notification contact at
  # create time and nothing consumes it at runtime any more -- the senders get a contact ID and
  # look the address up. See the variable's own description for why editing it later is a no-op.
  notify_email = var.notify_email
}

# What an operator may upload, and where each kind of upload goes (extracted into a notice, or
# ingested into the knowledge base as guidance). Config-tab CRUD; no Lambda and no agent tool --
# nothing the agent does depends on this table, it describes the intake side.
module "workflow_types" {
  source = "../../modules/workflow-types"

  name_prefix = var.name_prefix
  # Empty by default, which skips the extraction seed. See the variable: this deployment cannot
  # discover IDP's real configuration version names, so a placeholder here would produce the exact
  # silent misextraction the route/version pairing exists to prevent.
  seed_extraction_config_version = var.seed_extraction_config_version
}

module "upload_audit" {
  source      = "../../modules/upload-audit"
  name_prefix = var.name_prefix
}

# Starts a Bedrock ingestion job after a knowledge-base upload lands, and records whether the
# document actually got indexed. Without it a KB-routed upload sits in the bucket forever and
# consult-guidance never finds it, with no error anywhere -- the same failure the seed-corpus
# ingestion note below warns about, arriving one upload at a time instead of once at deploy.
module "kb_ingest_trigger" {
  source = "../../modules/kb-ingest-trigger"

  name_prefix       = var.name_prefix
  assets_bucket     = module.foundation.assets_bucket
  assets_bucket_arn = module.foundation.assets_bucket_arn
  # The same managed KB the seed corpus is ingested into, from the one entry in
  # local.kb_ingest_targets. Reading the module outputs directly rather than the local, because the
  # local is keyed for the null_resource's state addresses and is not a lookup table.
  kb_id                   = module.recon_agent.managed_kb_id
  kb_data_source_id       = module.recon_agent.managed_kb_data_source_id
  uploads_table_name      = module.upload_audit.uploads_table_name
  uploads_table_arn       = module.upload_audit.uploads_table_arn
  uploads_table_index_arn = module.upload_audit.uploads_table_index_arn
  lambda_zip              = module.lambda_package.zip_path
  lambda_source_hash      = module.lambda_package.source_code_hash
  vpc_subnet_ids          = local.vpc_subnets
  vpc_security_group_ids  = local.vpc_sgs
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
