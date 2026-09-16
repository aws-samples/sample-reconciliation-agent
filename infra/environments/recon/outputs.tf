output "idp_hook_function_arn" {
  description = "The ingest hook. Invoked by this stack's own EventBridge rule when idp_state_machine_arn is set; only needs wiring on the IDP side when it is not."
  value       = module.idp_hook.hook_function_arn
}

output "frontend_url" {
  description = "Public entry point for the recon console."
  value       = "https://${module.frontend.distribution_domain}"
}

output "console_settings_prefix" {
  description = "SSM path of the console-wide settings (access groups, app enablement, defaults). Seeded by Terraform from the tfvars groups, then owned by the console's Settings screen: an apply never reverts a stored value, and a blank seed's parameter is created by the UI on first save."
  value       = module.console_settings.prefix
}

output "okta_redirect_uri_to_register" {
  description = "Exact URL that must appear in the Okta OIDC app's Sign-in redirect URIs. Empty when auth_provider != okta."
  value       = module.frontend.okta_redirect_uri_to_register
}

output "intake_private_api_url" {
  description = "Base URL of the VPC-only intake REST API (POST <url>/items). Empty unless private_vpc = true. Reachable only through the execute-api interface endpoint — from the VPC, a VPN or Direct Connect, never the internet."
  value       = module.intake.private_api_invoke_url
}

# Both manual steps live in systems Terraform does not own (an IDP stack and an Okta org), so an
# apply can succeed and the platform still not work — an unregistered Okta callback breaks login
# with no sign of it in the plan. Enumerate the out-of-band steps in the apply output rather than
# leaving them to tribal knowledge.
output "post_deploy_checklist" {
  description = "Out-of-band steps Terraform cannot perform. Review after every apply."
  value = compact([
    # Listed only when this stack has NOT been told which state machine to watch. With
    # idp_state_machine_arn set, the rule in the idp-hook module is the trigger and the IDP-side hook
    # setting must stay unset -- both would fire the hook on the same document, ingesting every
    # notice twice. So the two wiring options are mutually exclusive, never both.
    var.idp_state_machine_arn != "" ? "" : "IDP: nothing invokes the ingest hook. Either set idp_state_machine_arn to the document-processing state machine (preferred -- this stack then owns the rule), or set IDP's PostProcessingLambdaHookFunctionArn = ${module.idp_hook.hook_function_arn}. Until one of the two is done, uploads complete and the notices table stays empty with no error anywhere.",
    var.auth_provider != "okta" ? "" : "Okta: add '${module.frontend.okta_redirect_uri_to_register}' to the OIDC app's Sign-in redirect URIs (and 'https://${module.frontend.distribution_domain}' to Sign-out redirect URIs).",
    var.auth_provider != "okta" || module.frontend.okta_redirect_uri_is_pinned ? "" : "Okta: the callback URL above is DERIVED from the current CloudFront domain and will change if the distribution is recreated, breaking login. Pin it by setting the okta_redirect_uri variable to that value.",
    # A blank console admin group is a supported, fail-closed state -- but a quiet one: the Settings
    # screens render read-only with a note, and nothing else says why. Name it here so the operator
    # who wonders why nobody can edit access groups reads the answer in the apply output.
    var.console_admin_group != "" ? "" : "Console settings: console_admin_group is blank, so nobody can edit console-wide settings (access groups, app enablement, defaults) from the UI; every change needs a tfvars edit and an apply until an IdP group is named there.",
    # The private intake API's two gaps. Both are silent: a rejected request writes no log line
    # anywhere, and the SigV4 posture is not obvious from the URL alone.
    !var.private_vpc ? "" : "Private intake API: access logging is OFF because REST-API CloudWatch logging needs an account-level role this stack deliberately does not own (it is a per-account singleton). A request rejected by the resource policy or by IAM leaves NO trace. To enable: create a role trusting apigateway.amazonaws.com with AmazonAPIGatewayPushToCloudWatchLogs, run 'aws apigateway update-account --patch-operations op=replace,path=/cloudwatchRoleArn,value=<role-arn>', then add access_log_settings to aws_api_gateway_stage.v1 in modules/intake/private_api.tf.",
    !var.private_vpc ? "" : "Private intake API: it is authorized with AWS_IAM (SigV4), not a bearer token, so a caller needs credentials plus execute-api:Invoke on ${module.intake.private_api_id}. There is no IdP in that path on purpose — a Lambda authorizer verifying Okta tokens would have to fetch Okta's JWKS from inside the VPC and would fail closed once the NAT is removed.",
  ])
}

# ---------------------------------------------------------------------------------
# chatbot-app/frontend/.env.local for running the console on a laptop AGAINST THIS DEPLOYMENT:
#
#   terraform output -raw frontend_env_local > ../../../chatbot-app/frontend/.env.local
#   (cd ../../../chatbot-app/frontend && npm run dev)     # the BFF runs with your AWS credentials
#
# Every value is read back from the console task definition this root deploys
# (module.frontend.task_environment) rather than re-derived here, so a laptop and the container
# cannot disagree on what a variable means. The only lines that are NOT the task's are the
# local-development settings .env.example documents: anonymous access on, the sample corpus read
# from disk, the browser-side auth provider (a build argument in the container, a runtime variable
# under `next dev`) and the console default model's env fallback.
#
# Indexing the map (not lookup() with a default) is deliberate: a name .env.example documents that
# the task no longer sets fails the plan here instead of rendering an empty value the BFF would
# report as a missing variable at the first request.
#
# Sensitive because the task environment carries EMAIL_CONFIRMATION_TOKEN. `output -raw` prints a
# sensitive output regardless, and .env.local is gitignored (*.local).
# ---------------------------------------------------------------------------------
locals {
  console_env = module.frontend.task_environment
}

output "frontend_env_local" {
  description = "Complete chatbot-app/frontend/.env.local for a laptop run of the console against this deployment, rendered from the console task's own environment. Use with `terraform output -raw frontend_env_local`."
  sensitive   = true
  value       = <<-EOT
    # Rendered by `terraform output -raw frontend_env_local` in infra/environments/recon for the
    # ${var.name_prefix} deployment. Every value is the console task's own; .env.example says what each
    # name means. Re-render after an apply rather than editing by hand.

    # --- Authorization -----------------------------------------------------------------------------
    # Local-dev mode: skip token verification and grant every configured app group (and both admin
    # roles) to the single anonymous subject. Never set in a deployment.
    ALLOW_ANONYMOUS_API=true
    # Preview the shell as a restricted user, e.g. a pipeline user who is not an admin:
    # ANONYMOUS_GROUPS=deal-desk
    RECON_ACCESS_GROUP=${local.console_env["RECON_ACCESS_GROUP"]}
    RECON_ADMIN_GROUP=${local.console_env["RECON_ADMIN_GROUP"]}
    PIPELINE_ACCESS_GROUP=${local.console_env["PIPELINE_ACCESS_GROUP"]}
    PIPELINE_ADMIN_GROUP=${local.console_env["PIPELINE_ADMIN_GROUP"]}
    # The composed console's two switches, as this deployment sets them: exactly "false" hides the Deal
    # Pipeline and 403s its API; exactly "true" makes an UNSET access group admins-only instead of
    # open. Anonymous mode grants every group, so they only show under ANONYMOUS_GROUPS.
    PIPELINE_ENABLED=${local.console_env["PIPELINE_ENABLED"]}
    REQUIRE_ACCESS_GROUPS=${local.console_env["REQUIRE_ACCESS_GROUPS"]}
    # Console-wide settings: the SSM layer under this prefix OVERLAYS the group variables above
    # (stored -> env -> default) and is edited from the console's Settings screen; this root seeds it
    # from the same tfvars values, so the two agree until someone edits in the UI. Comment the prefix
    # out to run env-only (the Settings screens then render read-only). CONSOLE_ADMIN_GROUP is
    # environment-only by design -- no stored value can grant it -- and anonymous mode makes you a
    # console admin anyway.
    CONSOLE_SETTINGS_PREFIX=${local.console_env["CONSOLE_SETTINGS_PREFIX"]}
    CONSOLE_ADMIN_GROUP=${local.console_env["CONSOLE_ADMIN_GROUP"]}
    CONSOLE_ORGANIZATION_LABEL="${local.console_env["CONSOLE_ORGANIZATION_LABEL"]}"
    # Env fallback for the console default model an app may copy. The pipeline's model id doubles as
    # that default (main.tf, console_settings.default_model_id), so the same value seeds
    # ${local.console_env["CONSOLE_SETTINGS_PREFIX"]}/defaults/model-id, which wins once stored.
    CONSOLE_DEFAULT_MODEL_ID=${var.pipeline_agent_model_id}
    # Browser-side login flow (build-time in the container; runtime here).
    NEXT_PUBLIC_AUTH_PROVIDER=${var.auth_provider}
    AWS_REGION=${local.console_env["AWS_REGION"]}
    # Server-side token verification, read only when anonymous mode is off. The task's values, kept
    # commented so `next dev` stays anonymous; uncomment and complete (see .env.example) to verify
    # real tokens from the laptop.
    # AUTH_PROVIDER=${local.console_env["AUTH_PROVIDER"]}
    # OKTA_ISSUER=${local.console_env["OKTA_ISSUER"]}
    # OKTA_CLIENT_ID=${local.console_env["OKTA_CLIENT_ID"]}
    # AUTH_GROUPS_CLAIM=${local.console_env["AUTH_GROUPS_CLAIM"]}

    # --- Trade Reconciliation (/api/recon) ---------------------------------------------------------
    CASES_TABLE=${local.console_env["CASES_TABLE"]}
    AUDIT_TABLE=${local.console_env["AUDIT_TABLE"]}
    ASSETS_BUCKET=${local.console_env["ASSETS_BUCKET"]}
    SKILLS_CATALOG_KEY=${local.console_env["SKILLS_CATALOG_KEY"]}
    SKILLS_PREFIX=${local.console_env["SKILLS_PREFIX"]}
    SYSTEM_PROMPT_KEY=${local.console_env["SYSTEM_PROMPT_KEY"]}
    HARNESS_SYSTEM_PROMPT_KEY=${local.console_env["HARNESS_SYSTEM_PROMPT_KEY"]}
    LESSONS_TABLE=${local.console_env["LESSONS_TABLE"]}
    GRAPH_MAILBOX=${local.console_env["GRAPH_MAILBOX"]}
    CONTACTS_TABLE=${local.console_env["CONTACTS_TABLE"]}
    TEMPLATES_TABLE=${local.console_env["TEMPLATES_TABLE"]}
    WORKFLOW_TYPES_TABLE=${local.console_env["WORKFLOW_TYPES_TABLE"]}
    UPLOADS_TABLE=${local.console_env["UPLOADS_TABLE"]}
    IDP_INPUT_BUCKET=${local.console_env["IDP_INPUT_BUCKET"]}
    UPLOAD_STAGING_BUCKET=${local.console_env["UPLOAD_STAGING_BUCKET"]}
    EMAIL_PREPROCESS_FUNCTION=${local.console_env["EMAIL_PREPROCESS_FUNCTION"]}
    IDP_APPSYNC_ENDPOINT=${local.console_env["IDP_APPSYNC_ENDPOINT"]}
    NOTICES_TABLE=${local.console_env["NOTICES_TABLE"]}
    RECON_GATEWAY_URL=${local.console_env["RECON_GATEWAY_URL"]}
    REPROCESS_CAP=${local.console_env["REPROCESS_CAP"]}
    AGENT_RUNTIME_ARN=${local.console_env["AGENT_RUNTIME_ARN"]}
    AGENT_WORKER_FUNCTION=${local.console_env["AGENT_WORKER_FUNCTION"]}
    INTAKE_FUNCTION=${local.console_env["INTAKE_FUNCTION"]}
    POLICY_ENGINE_NAME=${local.console_env["POLICY_ENGINE_NAME"]}
    EGRESS_GATEWAY_ARN=${local.console_env["EGRESS_GATEWAY_ARN"]}
    TIER1_ENABLED_PARAM=${local.console_env["TIER1_ENABLED_PARAM"]}
    LAMBDA_SRC_PREFIX=${local.console_env["LAMBDA_SRC_PREFIX"]}
    RECON_MEMORY_ID=${local.console_env["RECON_MEMORY_ID"]}
    AUTO_RESOLVE_PARAM=${local.console_env["AUTO_RESOLVE_PARAM"]}
    COMMENT_REQUIREMENT_PARAM=${local.console_env["COMMENT_REQUIREMENT_PARAM"]}
    AGENT_BACKEND_PARAM=${local.console_env["AGENT_BACKEND_PARAM"]}
    AGENT_MODEL_PARAM=${local.console_env["AGENT_MODEL_PARAM"]}
    NAME_PREFIX=${local.console_env["NAME_PREFIX"]}
    HARNESS_CONFIG_VERSION_PARAM=${local.console_env["HARNESS_CONFIG_VERSION_PARAM"]}
    EVAL_RESULTS_LOG_GROUP_PREFIX=${local.console_env["EVAL_RESULTS_LOG_GROUP_PREFIX"]}
    HARNESS_LOG_GROUP=${local.console_env["HARNESS_LOG_GROUP"]}
    HARNESS_SERVICE_NAME=${local.console_env["HARNESS_SERVICE_NAME"]}
    ANALYST_AGREEMENT_EVALUATOR_ID=${local.console_env["ANALYST_AGREEMENT_EVALUATOR_ID"]}
    EMAIL_CONFIRMATION_TOKEN=${local.console_env["EMAIL_CONFIRMATION_TOKEN"]}
    AWS_ACCOUNT_ID=${local.console_env["AWS_ACCOUNT_ID"]}
    BACKEND_SERVICE_NAMES=${local.console_env["BACKEND_SERVICE_NAMES"]}
    BACKEND_EVENT_LOG_GROUPS=${local.console_env["BACKEND_EVENT_LOG_GROUPS"]}

    # --- Deal Pipeline (/api/pipeline) -------------------------------------------------------------%{if var.enable_deal_pipeline}
    PIPELINE_ASSETS_BUCKET=${local.console_env["PIPELINE_ASSETS_BUCKET"]}
    EMAILS_TABLE=${local.console_env["EMAILS_TABLE"]}
    DEALS_TABLE=${local.console_env["DEALS_TABLE"]}
    SKILL_PROPOSALS_TABLE=${local.console_env["SKILL_PROPOSALS_TABLE"]}
    KNOWLEDGE_MEMORY_ID=${local.console_env["KNOWLEDGE_MEMORY_ID"]}
    CHAT_MEMORY_ID=${local.console_env["CHAT_MEMORY_ID"]}
    PARSER_FUNCTION=${local.console_env["PARSER_FUNCTION"]}
    OMS_UPLOAD_FUNCTION=${local.console_env["OMS_UPLOAD_FUNCTION"]}
    PIPELINE_AGENT_MODEL_PARAM=${local.console_env["PIPELINE_AGENT_MODEL_PARAM"]}
    ASSISTANT_MODEL_ID=${local.console_env["ASSISTANT_MODEL_ID"]}
    # Local dev reads the simulate dialog's corpus from disk (relative to chatbot-app/frontend), so an
    # edited sample shows up without an apply; the container has no such directory and reads the S3
    # copy under PIPELINE_SAMPLES_PREFIX instead. Comment SAMPLE_EMAILS_DIR out to exercise that path.
    SAMPLE_EMAILS_DIR=../../data/deal-emails
    PIPELINE_SAMPLES_PREFIX=${local.console_env["PIPELINE_SAMPLES_PREFIX"]}
    PIPELINE_SKILLS_PREFIX=${local.console_env["PIPELINE_SKILLS_PREFIX"]}
    PARSER_PROMPT_KEY=${local.console_env["PARSER_PROMPT_KEY"]}%{else}
    # enable_deal_pipeline = false: this deployment has no pipeline resources, and PIPELINE_ENABLED=false
    # above hides the app. Set the variable, apply, and re-render this file to get the block.%{endif}
  EOT
}

# ---------------------------------------------------------------------------------
# The by-hand seed reconciliation for the pipeline bucket -- the run an operator makes BEFORE setting
# enable_pipeline_seed_push = true on a deployment whose pipeline predates the push (see that
# variable). Rendered from the module's own editable_seeds output, so the keys and repo files are
# exactly the ones aws_lambda_invocation.pipeline_seed_push will read; the repo paths are relative to
# the repo root, which is where the command must run:
#
#   eval "$(cd infra/environments/recon && terraform output -raw pipeline_seed_push_command)"
#
# Exit 0 means every key is adopted or already recorded and the variable can be flipped; exit 1 names
# each AMBIGUOUS key with the two commands that settle it (take repo, or keep live and commit it).
# Empty when the pipeline is not deployed. Not sensitive: a bucket name and repo-relative paths.
# ---------------------------------------------------------------------------------
output "pipeline_seed_push_command" {
  description = "Run from the repo root, with the deployer's AWS credentials, to adopt the pipeline's live skill and prompt objects into the seed reconciliation before enabling enable_pipeline_seed_push. Empty unless enable_deal_pipeline."
  value = var.enable_deal_pipeline ? join(" ", [
    "BUCKET=${try(module.deal_pipeline[0].assets_bucket, "")}",
    "SEEDS='${jsonencode(try({ for k, seed in module.deal_pipeline[0].editable_seeds : k => seed.source }, {}))}'",
    "python3 infra/scripts/push_editable_seeds.py",
  ]) : ""
}
