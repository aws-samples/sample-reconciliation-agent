# ---------------------------------------------------------------------------------
# Everything below reads the two COUNT-GATED modules -- the console's user pool (absent for an Okta or
# Entra deployment) and the frontend tier (absent in the cheap development profile) -- through these
# locals, and never by indexing them inline.
#
# ⚠️ That is not tidiness. Terraform's `? :` does not reliably defer the untaken branch, so
# `var.enable_frontend_tier ? module.frontend[0].x : ""` can still fail to resolve the index when the
# module has no instance. try() is the form that is safe in both states, and doing it once here means a
# later edit cannot reintroduce the inline version by accident.
# ---------------------------------------------------------------------------------
locals {
  cognito_pool_id    = try(module.console_auth[0].user_pool_id, "")
  cognito_client_id  = try(module.console_auth[0].spa_client_id, "")
  cognito_hosted_ui  = try(module.console_auth[0].hosted_ui_url, "")
  cognito_groups     = try(module.console_auth[0].group_names, {})
  cognito_group_list = try(module.console_auth[0].group_names_list, [])
  # The bare hosted-UI HOST (no scheme) is what the console reads as COGNITO_HOSTED_UI; the _url form
  # above is the same host as an origin, for a checklist line or an operator opening it directly.
  cognito_hosted_ui_host = try(module.console_auth[0].hosted_ui_domain, "")
  frontend_host          = try(module.frontend[0].distribution_domain, "")
  frontend_okta_uri      = try(module.frontend[0].okta_redirect_uri_to_register, "")
  frontend_okta_pin      = try(module.frontend[0].okta_redirect_uri_is_pinned, false)
  frontend_cognito_cb    = try(module.frontend[0].cognito_callback_url, "")
  frontend_cognito_lo    = try(module.frontend[0].cognito_logout_url, "")
}

output "idp_hook_function_arn" {
  description = "The ingest hook. Invoked by this stack's own EventBridge rule when idp_state_machine_arn is set; only needs wiring on the IDP side when it is not."
  value       = module.idp_hook.hook_function_arn
}

# Empty when enable_frontend_tier = false: there is no CloudFront distribution and no ALB, because the
# console is meant to be run from a laptop in that profile (see frontend_env_local below). An empty
# string rather than a placeholder, so a script that reads this output fails on nothing rather than on a
# URL that resolves to somebody else's host.
output "frontend_url" {
  description = "Public entry point for the recon console. Empty when the frontend tier is not deployed (enable_frontend_tier = false) — run the console locally and use frontend_env_local."
  value       = local.frontend_host != "" ? "https://${local.frontend_host}" : ""
}

output "console_settings_prefix" {
  description = "SSM path of the console-wide settings (access groups, app enablement, defaults). Seeded by Terraform from the tfvars groups, then owned by the console's Settings screen: an apply never reverts a stored value, and a blank seed's parameter is created by the UI on first save."
  value       = module.console_settings.prefix
}

output "okta_redirect_uri_to_register" {
  description = "Exact URL that must appear in the Okta OIDC app's Sign-in redirect URIs. Empty when auth_provider != okta or the frontend tier is not deployed."
  value       = local.frontend_okta_uri
}

# ---------------------------------------------------------------------------------
# The console's own user pool (auth_provider = "cognito").
#
# NONE of these is sensitive, and that is deliberate — see the note at the top of
# modules/console-auth/outputs.tf. A pool id, a hosted-UI host and a PUBLIC app client id all appear in
# the browser's own network traffic; marking them sensitive would conceal nothing and would force
# nonsensitive() through every consumer, while teaching a reader that the flow's security rests on them.
# It does not: this client has no secret, and PKCE is what replaces one.
#
# Every one is empty for an Okta or Entra deployment.
# ---------------------------------------------------------------------------------

output "cognito_user_pool_id" {
  description = "Id of the user pool the console signs in against. Also the pool an operator runs admin-create-user on — see cognito_first_user_commands. Empty unless auth_provider = cognito."
  value       = local.cognito_pool_id
}

output "cognito_spa_client_id" {
  description = "App client id of the console's public PKCE client: the `aud` the intake API's JWT authorizer and the BFF both require. Empty unless auth_provider = cognito."
  value       = local.cognito_client_id
}

output "cognito_hosted_ui_url" {
  description = "The sign-in page's own origin, https://<prefix>.auth.<region>.amazoncognito.com. Open it directly to check the pool is reachable before the console is. Empty unless auth_provider = cognito."
  value       = local.cognito_hosted_ui
}

output "cognito_group_names" {
  description = "The five groups this pool created, keyed by the role the console reads them for. Adding a user to one of these is the whole of granting access — the console compares the token's group claim against exactly these strings. Empty map unless auth_provider = cognito."
  value       = local.cognito_groups
}

# The single most useful thing to print after a first apply. A pool with no users is a console nobody
# can open, there is no self sign-up (by design), and the two calls are easy to get subtly wrong: the
# username has to be the email address because the pool uses email as its sign-in attribute, and access
# comes from the GROUP rather than from the user existing.
#
# Deliberately a list of commands rather than a script: an operator should read what they are about to
# run against their own account, and the address is theirs to supply.
output "cognito_first_user_commands" {
  description = "The two AWS CLI calls that create the first console operator and make them a console admin. Replace the email address with a real one. Empty unless auth_provider = cognito."
  value = var.auth_provider != "cognito" ? [] : [
    "aws cognito-idp admin-create-user --region ${var.region} --user-pool-id ${local.cognito_pool_id} --username you@example.com --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true",
    "aws cognito-idp admin-add-user-to-group --region ${var.region} --user-pool-id ${local.cognito_pool_id} --username you@example.com --group-name ${lookup(local.cognito_groups, "console-admin", "")}",
    "aws cognito-idp admin-add-user-to-group --region ${var.region} --user-pool-id ${local.cognito_pool_id} --username you@example.com --group-name ${lookup(local.cognito_groups, "recon-access", "")}",
  ]
}

output "intake_private_api_url" {
  description = "Base URL of the VPC-only intake REST API (POST <url>/items). Empty unless private_vpc = true. Reachable only through the execute-api interface endpoint — from the VPC, a VPN or Direct Connect, never the internet."
  value       = module.intake.private_api_invoke_url
}

# Both manual steps live in systems Terraform does not own (an IDP stack and an Okta org), so an
# apply can succeed and the platform still not work — an unregistered Okta callback breaks login
# with no sign of it in the plan. Enumerate the out-of-band steps in the apply output rather than
# leaving them to tribal knowledge.
#
# The tier flags are listed here too, for the same reason: `enable_agent_evals = false` produces an
# Evals tab with nothing in it and no error anywhere, which is indistinguishable from a broken one
# unless the apply said so.
output "post_deploy_checklist" {
  description = "Out-of-band steps Terraform cannot perform, and the consequences of any tier flag that is switched off. Review after every apply."
  value = compact([
    # Listed only when this stack has NOT been told which state machine to watch. With
    # idp_state_machine_arn set, the rule in the idp-hook module is the trigger and the IDP-side hook
    # setting must stay unset -- both would fire the hook on the same document, ingesting every
    # notice twice. So the two wiring options are mutually exclusive, never both.
    var.idp_state_machine_arn != "" ? "" : "IDP: nothing invokes the ingest hook. Either set idp_state_machine_arn to the document-processing state machine (preferred -- this stack then owns the rule), or set IDP's PostProcessingLambdaHookFunctionArn = ${module.idp_hook.hook_function_arn}. Until one of the two is done, uploads complete and the notices table stays empty with no error anywhere.",

    # --- Cognito: the pool exists, but a pool with no users is a console nobody can open. ---
    # There is no self sign-up on purpose, so this step is not optional and nothing else in the apply
    # hints at it.
    var.auth_provider != "cognito" ? "" : "Cognito: the user pool has NO users -- self sign-up is disabled by design, so nobody can sign in until an operator creates one. Run the calls in the cognito_first_user_commands output with a real address; the invite email carries a temporary password valid for 3 days. Access comes from GROUP membership, not from the account existing: the five groups are ${join(", ", local.cognito_group_list)}.",
    var.auth_provider != "cognito" || !var.enable_frontend_tier || var.enable_cognito_callback_patch ? "" : "Cognito: the callback patch is OFF (enable_cognito_callback_patch = false), so this deployment's own URLs are NOT registered on the app client and sign-in from the console will fail with redirect_mismatch. Add '${local.frontend_cognito_cb}' to the app client's allowed callback URLs and '${local.frontend_cognito_lo}' to its allowed sign-out URLs, then turn the patch back on so later applies keep them in step.",
    var.auth_provider != "cognito" || !var.cognito_local_dev_callbacks ? "" : "Cognito: http://localhost:${var.cognito_local_dev_port} is a registered callback and sign-out URL on the app client, so the console can be signed in to from `npm run dev` (see the frontend_env_local output). Set cognito_local_dev_callbacks = false for a deployment where sign-in should only be possible from the console's own host.",
    var.auth_provider != "cognito" || var.cognito_mfa_configuration == "ON" ? "" : "Cognito: MFA is '${var.cognito_mfa_configuration}', so an operator can hold the console's admin rights with a password alone. Set cognito_mfa_configuration = \"ON\" to require TOTP for every user before any real data reaches this deployment.",

    var.auth_provider != "okta" ? "" : "Okta: add '${local.frontend_okta_uri != "" ? local.frontend_okta_uri : "(the frontend tier is not deployed, so there is no URL to register yet)"}' to the OIDC app's Sign-in redirect URIs (and 'https://${local.frontend_host}' to Sign-out redirect URIs).",
    var.auth_provider != "okta" || !var.enable_frontend_tier || local.frontend_okta_pin ? "" : "Okta: the callback URL above is DERIVED from the current CloudFront domain and will change if the distribution is recreated, breaking login. Pin it by setting the okta_redirect_uri variable to that value.",
    # A blank console admin group is a supported, fail-closed state -- but a quiet one: the Settings
    # screens render read-only with a note, and nothing else says why. Name it here so the operator
    # who wonders why nobody can edit access groups reads the answer in the apply output. Read from
    # the RESOLVED group, so a Cognito deployment (where the pool creates the group) does not get a
    # warning about a group that exists.
    local.console_groups.console_admin != "" ? "" : "Console settings: no console admin group is configured, so nobody can edit console-wide settings (access groups, app enablement, defaults) from the UI; every change needs a tfvars edit and an apply until an IdP group is named in console_admin_group.",

    # --- Tier flags. Each of these fails SILENTLY in the UI, which is why they are printed. ---
    var.enable_frontend_tier ? "" : "Tier flag: enable_frontend_tier = false, so there is no ECS service, ALB or CloudFront distribution and the console has no deployed URL. Run it locally: `terraform output -raw frontend_env_local > ../../../chatbot-app/frontend/.env.local` then `npm run dev` in that directory. The BFF uses your own AWS credentials.",
    var.enable_private_networking ? "" : "Tier flag: enable_private_networking = false, so there is no NAT gateway and every Lambda plus the AgentCore Runtime runs UNATTACHED to your VPC (vpc_subnet_ids = []). They still reach AWS, over the Lambda service network -- but nothing that is only reachable inside the VPC is reachable from them.",
    var.enable_knowledge_base_corpus ? "" : "Tier flag: enable_knowledge_base_corpus = false, so the knowledge base is EMPTY and the consult-guidance skill retrieves nothing -- with no error anywhere, which reads in the UI as 'the filters work and match nothing'. The knowledge base itself still exists; set the flag true and re-apply to upload and ingest the corpus.",
    var.enable_agent_evals ? "" : "Tier flag: enable_agent_evals = false, so no session is scored: the Evals tab shows no results, the batch route has no analyst-agreement evaluator, and online_evals_enabled is ignored because there are no configs to disable.",
    var.enable_observability ? "" : "Tier flag: enable_observability = false, so the AgentCore Runtime's spans and OTEL logs are not delivered to CloudWatch. A failed investigation has no trace to read, and RUNTIME-backend sessions cannot be scored even with enable_agent_evals = true (the eval service reads content only from delivered log groups).",

    # The private intake API's two gaps. Both are silent: a rejected request writes no log line
    # anywhere, and the SigV4 posture is not obvious from the URL alone.
    !var.private_vpc ? "" : "Private intake API: access logging is OFF because REST-API CloudWatch logging needs an account-level role this stack deliberately does not own (it is a per-account singleton). A request rejected by the resource policy or by IAM leaves NO trace. To enable: create a role trusting apigateway.amazonaws.com with AmazonAPIGatewayPushToCloudWatchLogs, run 'aws apigateway update-account --patch-operations op=replace,path=/cloudwatchRoleArn,value=<role-arn>', then add access_log_settings to aws_api_gateway_stage.v1 in modules/intake/private_api.tf.",
    !var.private_vpc ? "" : "Private intake API: it is authorized with AWS_IAM (SigV4), not a bearer token, so a caller needs credentials plus execute-api:Invoke on ${module.intake.private_api_id}. There is no IdP in that path on purpose — a Lambda authorizer verifying the console's tokens would have to fetch the issuer's JWKS from inside the VPC and would fail closed once the NAT is removed.",
  ])
}

# ---------------------------------------------------------------------------------
# chatbot-app/frontend/.env.local for running the console on a laptop AGAINST THIS DEPLOYMENT:
#
#   terraform output -raw frontend_env_local > ../../../chatbot-app/frontend/.env.local
#   (cd ../../../chatbot-app/frontend && npm run dev)     # the BFF runs with your AWS credentials
#
# Every value is the one the console container is configured with, and there is exactly ONE list of
# names below whichever way this root is deployed:
#
#   * enable_frontend_tier = true -- read back from the task definition
#     (module.frontend[0].task_environment), so a laptop and the container cannot disagree about what a
#     variable means.
#   * enable_frontend_tier = false -- there is no task definition to read, so local.laptop_env below
#     composes the same map from the same module outputs this root already passes INTO the console
#     module. That is the cheap development profile's whole point: no ECS, no ALB, no CloudFront, and a
#     console that still runs against the real data plane.
#
# The duplication that second branch implies is checked rather than trusted: the `check` block below
# compares every name in local.laptop_env against the task definition whenever the tier IS deployed, so
# a value that drifts shows up as a plan-time warning naming this output instead of as a laptop that
# reads a different table from the container.
#
# The only lines that are NOT the console's own are the local-development settings .env.example
# documents: anonymous access on, the sample corpus read from disk, the browser-side NEXT_PUBLIC_*
# copies (build arguments in the container, runtime variables under `next dev`) and the console default
# model's env fallback.
#
# Indexing the map (not lookup() with a default) is deliberate: a name .env.example documents that
# neither source sets fails the plan here instead of rendering an empty value the BFF would report as a
# missing variable at the first request.
#
# Sensitive because the environment carries EMAIL_CONFIRMATION_TOKEN. `output -raw` prints a
# sensitive output regardless, and .env.local is gitignored (*.local).
# ---------------------------------------------------------------------------------
locals {
  # The console container's environment as this root knows it, for the profile that does not deploy the
  # container. Every value is the SAME expression this root passes to module.frontend, so the two cannot
  # be independently wrong -- with five exceptions, marked below, that are literals inside the console
  # module and are the only genuine duplication here.
  laptop_env = merge(
    {
      AWS_REGION = var.region

      # --- Recon BFF data plane ---
      CASES_TABLE   = module.foundation.cases_table
      AUDIT_TABLE   = module.foundation.audit_table
      ASSETS_BUCKET = module.foundation.assets_bucket
      LESSONS_TABLE = module.foundation.lessons_table
      # DUPLICATED LITERAL (console module): the catalog object's key.
      SKILLS_CATALOG_KEY = "skills-catalog.json"
      # These three are literals in the console module too, but this root already passes the same
      # strings to module.tier1, so they are spelled once per consumer rather than twice per file.
      SKILLS_PREFIX             = "skills/"
      SYSTEM_PROMPT_KEY         = "system-prompt.md"
      HARNESS_SYSTEM_PROMPT_KEY = "system-prompt-harness.md"
      GRAPH_MAILBOX             = var.graph_mailbox
      CONTACTS_TABLE            = module.contact_store.contacts_table_name
      TEMPLATES_TABLE           = module.contact_store.templates_table_name
      WORKFLOW_TYPES_TABLE      = module.workflow_types.workflow_types_table_name
      UPLOADS_TABLE             = module.upload_audit.uploads_table_name
      IDP_INPUT_BUCKET          = var.idp_input_bucket
      UPLOAD_STAGING_BUCKET     = module.foundation.assets_bucket
      EMAIL_PREPROCESS_FUNCTION = module.email_preprocess.function_name
      NOTICES_TABLE             = module.notice_store.notices_table_name
      RECON_GATEWAY_URL         = module.recon_agent.gateway_url
      REPROCESS_CAP             = tostring(var.reprocess_cap)
      AGENT_RUNTIME_ARN         = module.recon_agent.runtime_arn
      AGENT_WORKER_FUNCTION     = module.tier1.worker_function_arn
      INTAKE_FUNCTION           = module.intake.function_name
      POLICY_ENGINE_NAME        = module.recon_agent.policy_engine_name
      EGRESS_GATEWAY_ARN        = module.recon_agent.gateway_arn
      TIER1_ENABLED_PARAM       = module.foundation.tier1_enabled_param
      # DUPLICATED LITERAL (console module): the read-only Tier-1 source viewer's prefix.
      LAMBDA_SRC_PREFIX            = "lambda-src/tier1/"
      RECON_MEMORY_ID              = module.recon_agent.memory_id
      AUTO_RESOLVE_PARAM           = module.foundation.auto_resolve_param
      COMMENT_REQUIREMENT_PARAM    = module.foundation.comment_requirement_param
      AGENT_BACKEND_PARAM          = module.foundation.agent_backend_param
      AGENT_MODEL_PARAM            = module.foundation.agent_model_id_param
      NAME_PREFIX                  = var.name_prefix
      HARNESS_CONFIG_VERSION_PARAM = module.foundation.harness_config_version_param
      # Empty when enable_agent_evals = false, exactly as the console module receives them.
      EVAL_RESULTS_LOG_GROUP_PREFIX  = try(module.agent_evals[0].results_log_group_prefix, "")
      ANALYST_AGREEMENT_EVALUATOR_ID = try(module.agent_evals[0].evaluator_id, "")
      HARNESS_LOG_GROUP              = "aws/spans"
      HARNESS_SERVICE_NAME           = local.backend_service_names.harness
      EMAIL_CONFIRMATION_TOKEN       = random_password.email_confirmation.result
      AWS_ACCOUNT_ID                 = data.aws_caller_identity.current.account_id
      BACKEND_SERVICE_NAMES          = jsonencode(local.backend_service_names)
      BACKEND_EVENT_LOG_GROUPS       = jsonencode(local.backend_event_log_groups)

      # --- Authorization ---
      AUTH_PROVIDER         = var.auth_provider
      OKTA_ISSUER           = var.okta_issuer
      OKTA_CLIENT_ID        = var.okta_client_id
      COGNITO_USER_POOL_ID  = local.cognito_pool_id
      COGNITO_CLIENT_ID     = local.cognito_client_id
      COGNITO_HOSTED_UI     = local.cognito_hosted_ui_host
      AUTH_GROUPS_CLAIM     = local.auth_groups_claim
      RECON_ADMIN_GROUP     = local.console_groups.recon_admin
      RECON_ACCESS_GROUP    = local.console_groups.recon_access
      PIPELINE_ACCESS_GROUP = local.console_groups.pipeline_access
      PIPELINE_ADMIN_GROUP  = local.console_groups.pipeline_admin
      PIPELINE_ENABLED      = tostring(var.enable_deal_pipeline)
      REQUIRE_ACCESS_GROUPS = var.enable_deal_pipeline ? "true" : "false"

      # --- Console-wide settings ---
      CONSOLE_SETTINGS_PREFIX    = module.console_settings.prefix
      CONSOLE_ADMIN_GROUP        = local.console_groups.console_admin
      CONSOLE_ORGANIZATION_LABEL = var.console_organization_label
    },
    # The pipeline app's half, taken from the app module's OWN export -- the very list the console
    # module appends to the container environment -- so there is no duplication at all on this side.
    var.enable_deal_pipeline ? { for e in module.deal_pipeline[0].console_environment : e.name => e.value } : {},
  )

  console_env = try(module.frontend[0].task_environment, local.laptop_env)
}

# The duplication above, verified rather than trusted. Whenever the frontend tier IS deployed, every
# name local.laptop_env claims to know must hold the value the task definition actually carries.
#
# A `check` block rather than a precondition, deliberately: drift here means a laptop reads the wrong
# table, which is worth a loud warning on every plan and is never worth failing an apply over.
#
# The residual gap, stated so nobody assumes otherwise: this is one-directional. A name ADDED to the
# console module's environment and not to local.laptop_env is not caught here -- it surfaces instead as
# a missing-key plan error from the frontend_env_local template the moment the tier is switched off.
check "laptop_env_matches_the_console_task" {
  assert {
    # No nonsensitive() anywhere: a check assertion accepts a condition derived from a sensitive value
    # (both maps carry EMAIL_CONFIRMATION_TOKEN) and renders its message without leaking one. Unwrapping
    # would also be fragile in the other direction -- nonsensitive() ERRORS on a value that is not
    # sensitive, so it would start failing the moment the token stopped being the map's only secret.
    condition = !var.enable_frontend_tier || alltrue([
      for name, value in local.laptop_env :
      try(module.frontend[0].task_environment[name], null) == value
    ])
    error_message = "The laptop .env.local map (local.laptop_env in outputs.tf) no longer agrees with the console task definition. One of them was changed without the other, so `terraform output -raw frontend_env_local` would hand a developer a value the deployed container does not use. Compare the two: `terraform state show module.frontend[0].aws_ecs_task_definition.frontend`."
  }
}

output "frontend_env_local" {
  description = "Complete chatbot-app/frontend/.env.local for a laptop run of the console against this deployment. Rendered from the console task's own environment when the frontend tier is deployed, and from this root's own values when it is not. Use with `terraform output -raw frontend_env_local`."
  sensitive   = true
  value       = <<-EOT
    # Rendered by `terraform output -raw frontend_env_local` in infra/environments/recon for the
    # ${var.name_prefix} deployment. Every value is the console's own; .env.example says what each
    # name means. Re-render after an apply rather than editing by hand.
    %{if !var.enable_frontend_tier}#
    # This deployment has NO frontend tier (enable_frontend_tier = false): no ECS service, no ALB and no
    # CloudFront distribution. `npm run dev` with this file IS the console for this deployment, and it
    # talks to the real data plane through your own AWS credentials.
    %{endif}
    # --- Authorization -----------------------------------------------------------------------------
    # Local-dev mode: skip token verification and grant every configured app group (and both admin
    # roles) to the single anonymous subject. Never set in a deployment.
    ALLOW_ANONYMOUS_API=true
    # Preview the shell as a restricted user, e.g. a pipeline user who is not an admin:
    # ANONYMOUS_GROUPS=${local.console_env["PIPELINE_ACCESS_GROUP"]}
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
    AWS_REGION=${local.console_env["AWS_REGION"]}

    # Browser-side login flow. These are build arguments in the container (Next.js inlines every
    # NEXT_PUBLIC_* at build time) and runtime variables here under `next dev`, which is why they are
    # spelled out rather than read from the task's environment.
    NEXT_PUBLIC_AUTH_PROVIDER=${var.auth_provider}%{if var.auth_provider == "cognito"}
    NEXT_PUBLIC_COGNITO_USER_POOL_ID=${local.console_env["COGNITO_USER_POOL_ID"]}
    NEXT_PUBLIC_COGNITO_CLIENT_ID=${local.console_env["COGNITO_CLIENT_ID"]}
    NEXT_PUBLIC_COGNITO_HOSTED_UI=${local.console_env["COGNITO_HOSTED_UI"]}
    # Left UNSET on purpose: the browser then derives http://localhost:${var.cognito_local_dev_port}/callback from its own
    # origin, which is a registered callback URL on the app client%{if !var.cognito_local_dev_callbacks} -- except that
    # cognito_local_dev_callbacks is false for this deployment, so it is NOT registered and a local
    # sign-in will be refused with redirect_mismatch until you register it%{endif}. Pinning this to the
    # deployed host's URL would break the local flow, not fix it.
    # NEXT_PUBLIC_COGNITO_REDIRECT_URI=%{endif}

    # Server-side token verification, read only when anonymous mode is off. The console's own values,
    # kept commented so `next dev` stays anonymous; uncomment the provider line and its pair (see
    # .env.example) to verify real tokens from the laptop.
    # AUTH_PROVIDER=${local.console_env["AUTH_PROVIDER"]}
    # OKTA_ISSUER=${local.console_env["OKTA_ISSUER"]}
    # OKTA_CLIENT_ID=${local.console_env["OKTA_CLIENT_ID"]}
    # COGNITO_USER_POOL_ID=${local.console_env["COGNITO_USER_POOL_ID"]}
    # COGNITO_CLIENT_ID=${local.console_env["COGNITO_CLIENT_ID"]}
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

# The items table, for scripts that write ReconItem rows (scripts/seed_recon_demo_items.py). The
# other stores are reachable through the console; this one is the platform's entry point, and an
# item write is what starts Tier-1.
output "items_table" {
  description = "Name of the recon items DynamoDB table (the only stream-enabled table)."
  value       = module.foundation.items_table
}
