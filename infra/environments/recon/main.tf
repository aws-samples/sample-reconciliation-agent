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

# Shared secret gating email sends at the gateway interceptor (human-confirmation safeguard).
# No `keepers` → generated once and stable across applies; rotate by tainting this resource.
resource "random_password" "email_confirmation" {
  length  = 40
  special = false
}

# Private networking: subnets + NAT + S3/DynamoDB PrivateLink endpoints for all VPC-attached
# compute (Lambdas + AgentCore Runtime).
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

  # The OIDC issuer + audience the intake HTTP API's JWT authorizer validates. Derived from
  # auth_provider here, in ONE place, and deliberately the same derivation
  # chatbot-app/frontend/src/lib/api-auth.ts performs for the BFF: the API and the BFF must accept
  # exactly the same tokens, and two independent derivations would eventually disagree.
  #
  # There is no Cognito fallback. This stack used to run a user pool that existed solely to be this
  # issuer while the console signed in through Okta — one deployment, two identity providers, and the
  # pool's own Hosted UI orphaned. An unset provider now fails the plan in modules/intake's variable
  # validation rather than quietly authorizing against something nobody logs in to.
  #
  # Entra: the v2.0 issuer specifically. A v1 token (`sts.windows.net`) fails this check by design,
  # matching api-auth.ts.
  oidc_issuer = var.auth_provider == "okta" ? var.okta_issuer : (
    var.entra_tenant_id != "" ? "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0" : ""
  )
  oidc_audience = var.auth_provider == "okta" ? var.okta_client_id : var.entra_client_id

  # ADOT Python layer for the agent-worker Lambda. var.otel_layer_account is AWS's public publisher
  # for AWSOpenTelemetryDistroPython in every commercial region — a variable rather than a literal
  # because the repo's pre-push secret guard rejects bare 12-digit numbers. The layer is
  # arch-agnostic and covers python3.10-3.14.
  #
  # ⚠️ This is the DISTRO layer AWS documents for Lambda-hosted agents, not the aws-otel-python
  # collector layer. The collector layer is unsupported for agent observability and ships an
  # incompatible OTel version.
  otel_layer_arn = var.enable_worker_tracing ? "arn:aws:lambda:${var.region}:${var.otel_layer_account}:layer:AWSOpenTelemetryDistroPython:${var.otel_layer_version}" : ""

  # One definition shared by the worker Lambda (which SETS these baggage keys) and the harness
  # (which promotes them to span attributes) — they must not drift apart. The first two are
  # AgentCore's own; the recon.* keys come from backend/recon_core/otel_client.py.
  otel_baggage_span_attribute_keys = "harness.id,harness.endpoint.qualifier,session.id,recon.item_id,recon.domain,recon.backend"
}

module "foundation" {
  source = "../../modules/foundation"

  name_prefix = var.name_prefix
}

module "frontend" {
  source = "../../modules/frontend-ecs"

  name_prefix  = var.name_prefix
  region       = var.region
  account_id   = data.aws_caller_identity.current.account_id
  frontend_dir = "${path.root}/../../../chatbot-app/frontend"
  vpc_id       = data.aws_vpc.default.id

  # Build-time NEXT_PUBLIC_* wiring (recon BFF base; the IdP args follow).
  recon_api_base = module.intake.api_endpoint

  # Identity provider selection (Okta OIDC vs Entra) — baked into the frontend build.
  auth_provider     = var.auth_provider
  okta_issuer       = var.okta_issuer
  okta_client_id    = var.okta_client_id
  okta_redirect_uri = var.okta_redirect_uri

  # Who may change platform configuration. Empty means nobody — see the variable's own note.
  recon_admin_group = var.recon_admin_group
  auth_groups_claim = var.auth_groups_claim

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
  # Documents tab -> recon's OWN notices table. The whole tab now: the list, the detail and the
  # extracted fields. So it needs no grant on anyone else's API and no variable in `terraform.tfvars`
  # -- which also means CI cannot drift on it, the way a hand-copied `RECON_TFVARS` key can.
  #
  # The grant the module builds from these is READ-ONLY, and stays that way. The notices table is what
  # the deterministic matcher and the gateway interceptor read, so a task that could write it could
  # change what reconciliation concluded -- from a tab whose only job is to display.
  #
  # Both ARNs, because the list view is a Query on the `idp-document-index` GSI and IAM treats a GSI as
  # a resource distinct from its table. The index ARN is composed by the notice-store module that owns
  # the index name, not spelled out here.
  notices_table           = module.notice_store.notices_table_name
  notices_table_arn       = module.notice_store.notices_table_arn
  notices_table_index_arn = module.notice_store.notices_table_index_arn
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
  # ...and the batch path invokes that evaluator's Lambda under a FAS from the task role, so the
  # role needs the ARN to grant lambda:InvokeFunction on it.
  analyst_agreement_lambda_arn = module.agent_evals.evaluator_lambda_arn
  # Backend-aware batch/re-score data sources (same maps the online eval configs use).
  backend_service_names    = local.backend_service_names
  backend_event_log_groups = local.backend_event_log_groups

  # Private-VPC deployment (ONE flag): no CloudFront, internal ALB on private subnets, Fargate
  # with no public IP egressing via the network module's interface endpoints. False selects the
  # public CloudFront topology instead.
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

  name_prefix       = var.name_prefix
  assets_bucket_arn = module.foundation.assets_bucket_arn
}

module "intake" {
  source = "../../modules/intake"

  name_prefix     = var.name_prefix
  items_table     = module.foundation.items_table
  items_table_arn = module.foundation.items_table_arn
  # The HTTP API's JWT authorizer validates the SAME issuer the console signs in against — see the
  # oidc_* locals above. There is no user pool behind this any more.
  jwt_issuer             = local.oidc_issuer
  jwt_audience           = local.oidc_audience
  lambda_zip             = module.lambda_package.zip_path
  lambda_source_hash     = module.lambda_package.source_code_hash
  vpc_subnet_ids         = local.vpc_subnets
  vpc_security_group_ids = local.vpc_sgs

  # An HTTP API cannot be made private, so private_vpc would otherwise leave the platform's only
  # synchronous write endpoint internet-facing while everything else moved inside. This adds a PRIVATE
  # REST API onto the same intake Lambda, locked to the execute-api interface endpoint and authorized
  # with SigV4. The public HTTP API is left in place — the two doors share the handler, so neither can
  # drift from the other.
  private_api_enabled         = var.private_vpc
  execute_api_vpc_endpoint_id = module.network.execute_api_endpoint_id
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

  # Invoke the agent THROUGH the ingress gateway, with a direct-invoke fallback.
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

  # Apply-time readiness waits (managed-KB data source, managed-kb connector target) run inside the
  # deploy-actions Lambda, so nothing on the machine running Terraform is polled or required.
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
  assets_bucket     = module.foundation.assets_bucket
  assets_bucket_arn = module.foundation.assets_bucket_arn

  # Cedar principal gating for the platform-only recon_update_status tool. Role NAMES are
  # constructed by naming convention — referencing module outputs here would create a
  # frontend<->recon-agent dependency cycle. The frontend module names its task role
  # "<prefix>-frontend-ecs-task"; harness/tier1 name theirs "<prefix>-harness-exec" /
  # "<prefix>-agent-worker".
  platform_role_names = ["${var.name_prefix}-frontend-ecs-task"]
  agent_role_names    = ["${var.name_prefix}-harness-exec", "${var.name_prefix}-agent-worker"]

  # Gateway REQUEST interceptor mode: log (observe only) or enforce (block on violation).
  interceptor_mode = var.interceptor_mode

  # Counterparty-email recipient allowlist. This module is the ONLY consumer, because the gateway
  # request interceptor is the single enforcement point. Deliberately NOT passed to frontend-ecs: a
  # BFF copy could only ever agree with this list or be wrong about it, and when it is wrong the
  # operator sees an unexplained blocked save.
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

  # AgentCore Policy confidence gate. Run LOG_ONLY and read the live Cedar decision logs from real
  # harness runs before flipping to ENFORCE — a policy that has never been observed deciding is a
  # policy that has never been validated.
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
  # Deliberately left off here (unlike on the worker Lambda): the online evaluators score gen-ai
  # CONTENT records read from this harness's log group, and both of these settings suppress content.
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
  # Maintenance lever: false disables both configs, which releases the service-side lock on the
  # custom evaluator so its description/Lambda config can be updated. See the module's evaluator.
  online_evals_enabled = var.online_evals_enabled
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
  # `aws_lambda_invocation.seed_push` (every apply, unless the live object was edited). Keep it that
  # way: two lists would let a skill be seeded but never pushed, or pushed but never seeded, and
  # neither half-wiring surfaces as an error anywhere.
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
# names). The harness worker appends this after the shared policy core in system_prompt_seed below;
# the policy itself is NOT duplicated here, so the two backends cannot drift apart.
#
# Create-only like the other editable objects: this resource writes the object once and never
# overwrites the live text. Repo edits still reach S3 without a manual `aws s3 cp` —
# `aws_lambda_invocation.seed_push` below re-pushes every changed `local.editable_seeds` entry on
# each apply, and fails the apply on a two-sided conflict.
resource "aws_s3_object" "harness_system_prompt_seed" {
  bucket       = module.foundation.assets_bucket
  key          = "system-prompt-harness.md"
  source       = local.editable_seeds["system-prompt-harness.md"]
  etag         = filemd5(local.editable_seeds["system-prompt-harness.md"])
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source]
  }
}

# Skills-catalog BFF only — deliberately the whole of this API's surface. The UI's queue decisions
# run in the frontend's same-origin BFF via the gateway's platform tools, so there is exactly one
# human-in-the-loop code path and no JWT-fronted duplicate of it to keep in step.
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

  # Deliver runtime TRACES to CloudWatch so the online eval config can score runtime-backend
  # sessions. Requires account-level CloudWatch Transaction Search to be enabled — that is an
  # account setting, not something this stack owns.
  enable_xray_traces = true
}

# Upload the KB seed corpus to the assets bucket's knowledge-base/ prefix.
#
# The corpus is a directory TREE, not a flat pair of files: playbooks/ holds the reconciliation
# methodology, retrieved_emails/ holds archived correspondence (HTML bodies plus PDF and
# spreadsheet attachments), and every document has a sibling <name>.<ext>.metadata.json sidecar
# carrying the attributes the agent filters on. tests/kb_seed/ asserts that shape.
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
# ⚠️ ONLY a managed KB. Do not add an **S3 Vectors**-backed one beside it: this corpus violates two
# of S3 Vectors' hard limits, both confirmed against a live ingestion job.
#
#   1. Sidecar FILE size limit of 1024 bytes -- "Ignored 8 files as the associated metadata was
#      larger than service limit of MaximumFileSizeSupported: 1024 bytes". Every
#      retrieved_emails/*.metadata.json exceeds it (1149-1217 bytes even minified: the
#      {"value":{"type":...},"includeForEmbedding":...} envelope costs ~70 bytes per attribute and
#      an email carries 10). Those documents are ignored OUTRIGHT -- they never appear in
#      ListKnowledgeBaseDocuments, not even as FAILED.
#   2. "Filterable metadata must have at most 2048 bytes (Service: S3Vectors, Status Code: 400)" --
#      4 of the 7 playbooks hard-FAIL. This limit has no observable discriminator: two playbooks
#      with IDENTICAL metadata land on opposite sides of it, and the failing set's sizes (522-575
#      bytes) overlap the passing set's exactly. Do not try to reason it out from sidecar size.
#
# The managed KB has neither limit -- it indexes every document in the corpus, sidecars of 1610-1660
# bytes included. So the metadata design and an S3 Vectors index are mutually exclusive: supporting
# both would mean gutting the attribute set corpus-wide, degrading exactly the retrieval filtering
# the sidecars exist to provide.
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
# local.kb_ingest_targets holds a single entry, but the for_each stays: the state addresses are keyed
# on it, so collapsing to a bare resource would destroy and re-create the managed ingestion for no
# gain.
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
# count, and a managed-KB job can drop documents while still reporting 0 failed. Exposed as an
# output so the numbers appear in the apply log rather than only in the invocation result.
# If they look wrong, go to ListKnowledgeBaseDocuments — a dropped document is simply ABSENT.

output "kb_ingestion_counts" {
  description = "Per-KB ingestion job id and scanned/indexed/failed document counts from this apply."
  value       = { for k, invocation in aws_lambda_invocation.kb_ingestion : k => jsondecode(invocation.result) }
}

# Seed the editable skills/ prefix from the repo. These objects are the live source the BFF skills
# manager and the agent read at runtime; UI edits overwrite them in place with no redeploy. The
# lifecycle ignore is what stops the next apply from reverting those edits — seeding is first-write
# only. The key => file map lives in local.editable_seeds so the deploy-time push
# (aws_lambda_invocation.seed_push) cannot drift from what is seeded here.
resource "aws_s3_object" "skill_seed" {
  # Keyed on the FILE NAME rather than the bucket key. The state addresses derive from this key, so
  # re-keying on the bucket key would destroy and recreate every seeded object.
  for_each = {
    for k, f in local.editable_seeds : basename(f) => { key = k, source = f }
    if startswith(k, "skills/")
  }

  bucket       = module.foundation.assets_bucket
  key          = each.value.key
  source       = each.value.source
  etag         = filemd5(each.value.source)
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source]
  }
}

# Push repo edits to the create-only seeds above, UNLESS the live object was edited in this
# environment. This resource is load-bearing: the seeds carry `ignore_changes` so that UI edits
# survive an apply, and without a push step that same ignore would mean a repo edit to a prompt or a
# skill never reaches S3 at all — the apply goes green while the deployed agent runs the previously
# seeded instructions.
#
# The reconciliation logic (and every failure message) lives in the committed script rather than
# here, because it has a second caller: an operator resolving a conflict runs the same script by hand.
#
# ⚠️ This resource can FAIL the apply, by design. If a repo file AND the live object have both changed
# since the last push, no rule resolves that without a human, so it stops and names every stuck key
# with the two commands that fix it. A UI edit on its own is not a conflict — it wins silently.
resource "aws_lambda_invocation" "seed_push" {
  function_name = module.deploy_actions.function_name

  input = jsonencode({
    action = "push_editable_seeds"
    bucket = module.foundation.assets_bucket
    # ⚠️ The CONTENT travels in the payload, not a path: the actor Lambda has no repo checkout.
    # Inlining it also makes this invocation's input change whenever a seed changes, which is what
    # re-runs the reconciliation. `source` is carried only so a conflict message can name the repo
    # file an operator has to reconcile.
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

  # Seeding is create-only (`ignore_changes = [etag, source]`), so the objects must exist before the
  # reconciliation reads their ETags — a missing object is the "record" branch, and racing it would
  # write a marker for content the seed resource is about to create.
  depends_on = [
    aws_s3_object.system_prompt_seed,
    aws_s3_object.harness_system_prompt_seed,
    aws_s3_object.skill_seed,
  ]
}

# The SHARED policy core. Read by the runtime container AND by the harness worker (which appends
# the contract object above), and rewritten in place by the UI prompt editor and by deploying a
# config version — so there is exactly one artifact holding the agent's instructions.
resource "aws_s3_object" "system_prompt_seed" {
  bucket       = module.foundation.assets_bucket
  key          = "system-prompt.md"
  source       = local.editable_seeds["system-prompt.md"]
  etag         = filemd5(local.editable_seeds["system-prompt.md"])
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source]
  }
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
  # The recon gateway's INBOUND auth is AWS_IAM (SigV4), not Entra — OBO's token exchange needs an
  # Entra-issued user token to swap, and there is none. App-only (client_credentials) is the only
  # mode compatible with a non-Entra-fronted gateway.
  auth_mode = "client_credentials"
}

# IDP push entry point: hook Lambda that maps IDP-completed documents to extracted notices. Set
# idp_state_machine_arn below and this stack owns the EventBridge rule that invokes it; leave it
# empty and the hook must instead be registered on the IDP side. Never both.
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
  # The ONLY place this variable is read. It seeds the first internal-notification contact at create
  # time; nothing consumes it at runtime, because the senders receive a contact ID and resolve the
  # address themselves. See the variable's own description for why editing it later is a no-op.
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
# consult-guidance never finds it, with no error anywhere. Same failure mode as an un-ingested seed
# corpus (see aws_lambda_invocation.kb_ingestion above), one upload at a time instead of all at once.
module "kb_ingest_trigger" {
  source = "../../modules/kb-ingest-trigger"

  name_prefix       = var.name_prefix
  assets_bucket     = module.foundation.assets_bucket
  assets_bucket_arn = module.foundation.assets_bucket_arn
  # The same managed KB the seed corpus is ingested into. Reads the module outputs directly rather
  # than local.kb_ingest_targets: that local exists to key the ingestion invocation's state
  # addresses, not to serve as a lookup table.
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
# `general-ledger` Gateway tool. Also owns the `set_draw_status` write Lambda, which performs the
# write only — the confidence gate is Cedar's and the provenance gate is the interceptor's, each
# enforced in exactly one place rather than copied here.
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
}
