# Every value the frontend's .env.local needs (design §11), one output each, plus `env_local`
# which renders the whole file:
#
#   terraform output -raw env_local > ../../../chatbot-app/frontend/.env.local
#
# The access-control constants, NEXT_PUBLIC_AUTH_PROVIDER and SAMPLE_EMAILS_DIR are application
# settings the design fixes for local development, not infrastructure. They are outputs anyway so
# the rendered file is complete and nothing has to be typed by hand.
#
# Three names are PIPELINE_-prefixed -- PIPELINE_ASSETS_BUCKET, PIPELINE_AGENT_MODEL_PARAM,
# PIPELINE_SKILLS_PREFIX -- because the frontend is one process serving two apps, and the recon app
# already reads ASSETS_BUCKET, AGENT_MODEL_PARAM and SKILLS_PREFIX for ITS bucket, parameter and
# prefix. The pipeline BFF reads the prefixed name first and falls back to the bare one, so this
# file uses the names the ECS task definition uses (infra/modules/frontend-ecs) and a developer's
# laptop and a deployment agree on what every variable means.

locals {
  # Anonymous API access is the local-dev mode (design §9): the BFF runs on the developer's
  # laptop with the developer's credentials and there is no IdP in this deployment. ONE switch for
  # both apps -- there is one server process, so the older PIPELINE_ALLOW_ANONYMOUS_API (still
  # honoured by the BFF) could never have left one app open and the other verified. Anonymous mode
  # grants every configured app group; ANONYMOUS_GROUPS narrows that to preview a restricted user.
  allow_anonymous_api = "true"
  # Group name the BFF checks for approve/reject, skill writes, memory delete and config PUT once
  # an IdP is wired up. Irrelevant while anonymous access is on, but the design fixes the name.
  pipeline_admin_group = "deal-desk-admins"
  # Empty = OPEN: every authenticated user may use the pipeline app, which is the behaviour every
  # deployment had before the app rail existed. Members of pipeline_admin_group have access
  # regardless, so restricting is one variable: name a group here.
  pipeline_access_group = ""
  # The frontend's auth-provider switch; the design keeps the existing app's default.
  next_public_auth_provider = "entra"
  # Relative to chatbot-app/frontend, where `npm run dev` runs. Local dev reads the corpus from
  # disk, so an edited sample shows up without an apply; the deployed console reads the S3 copy the
  # module seeds under samples_prefix instead (PIPELINE_SAMPLES_PREFIX, see env_local).
  sample_emails_dir = "../../data/deal-emails"
}

output "allow_anonymous_api" {
  value = local.allow_anonymous_api
}

output "pipeline_admin_group" {
  value = local.pipeline_admin_group
}

output "pipeline_access_group" {
  description = "Empty: the pipeline app is open to every authenticated user (see locals)."
  value       = local.pipeline_access_group
}

output "next_public_auth_provider" {
  value = local.next_public_auth_provider
}

output "aws_region" {
  value = module.deal_pipeline.region
}

output "account_id" {
  value = module.deal_pipeline.account_id
}

output "assets_bucket" {
  value = module.deal_pipeline.assets_bucket
}

output "emails_table" {
  value = module.deal_pipeline.emails_table
}

output "deals_table" {
  value = module.deal_pipeline.deals_table
}

output "skill_proposals_table" {
  value = module.deal_pipeline.skill_proposals_table
}

output "knowledge_memory_id" {
  value = module.deal_pipeline.knowledge_memory_id
}

output "knowledge_memory_arn" {
  value = module.deal_pipeline.knowledge_memory_arn
}

output "chat_memory_id" {
  value = module.deal_pipeline.chat_memory_id
}

output "chat_memory_arn" {
  value = module.deal_pipeline.chat_memory_arn
}

output "parser_function" {
  value = module.deal_pipeline.parser_function_name
}

output "parser_function_arn" {
  value = module.deal_pipeline.parser_function_arn
}

output "oms_upload_function" {
  value = module.deal_pipeline.oms_upload_function_name
}

output "oms_upload_function_arn" {
  value = module.deal_pipeline.oms_upload_function_arn
}

output "agent_model_param" {
  value = module.deal_pipeline.agent_model_param
}

output "assistant_model_id" {
  description = "Model the BFF's assistant route invokes. Same variable as the parser seed; the assistant has no Config-tab override."
  value       = var.agent_model_id
}

output "sample_emails_dir" {
  value = local.sample_emails_dir
}

output "samples_prefix" {
  description = "S3 prefix of the seeded sample corpus. Local dev reads the disk copy instead; set PIPELINE_SAMPLES_PREFIX to this value to exercise the S3 path the deployed console uses."
  value       = module.deal_pipeline.samples_prefix
}

output "skills_prefix" {
  value = module.deal_pipeline.skills_prefix
}

output "parser_prompt_key" {
  value = module.deal_pipeline.parser_prompt_key
}

# The RECON_* lines are commented out, not omitted: the shell resolves BOTH apps from the
# environment, and a reader of the rendered file should see that the recon app's groups are a
# deliberate blank here (the recon stack is a separate root, infra/environments/recon, and is not
# deployed by this one) rather than wonder whether something is missing. Anonymous mode grants
# every configured group anyway, so with these unset the local shell shows both apps as admin.
output "env_local" {
  description = "Complete chatbot-app/frontend/.env.local body (design §11). Use with `terraform output -raw env_local`."
  value       = <<-EOT
    ALLOW_ANONYMOUS_API=${local.allow_anonymous_api}
    PIPELINE_ADMIN_GROUP=${local.pipeline_admin_group}
    # Empty = open to every authenticated user; members of PIPELINE_ADMIN_GROUP have access regardless.
    PIPELINE_ACCESS_GROUP=${local.pipeline_access_group}
    # The recon stack is a separate root (infra/environments/recon) and is not deployed by this one.
    # RECON_ACCESS_GROUP=
    # RECON_ADMIN_GROUP=
    # Preview the shell as a restricted user, e.g. a pipeline user who is not an admin:
    # ANONYMOUS_GROUPS=deal-desk
    NEXT_PUBLIC_AUTH_PROVIDER=${local.next_public_auth_provider}
    AWS_REGION=${module.deal_pipeline.region}
    PIPELINE_ASSETS_BUCKET=${module.deal_pipeline.assets_bucket}
    EMAILS_TABLE=${module.deal_pipeline.emails_table}
    DEALS_TABLE=${module.deal_pipeline.deals_table}
    SKILL_PROPOSALS_TABLE=${module.deal_pipeline.skill_proposals_table}
    KNOWLEDGE_MEMORY_ID=${module.deal_pipeline.knowledge_memory_id}
    CHAT_MEMORY_ID=${module.deal_pipeline.chat_memory_id}
    PARSER_FUNCTION=${module.deal_pipeline.parser_function_name}
    OMS_UPLOAD_FUNCTION=${module.deal_pipeline.oms_upload_function_name}
    PIPELINE_AGENT_MODEL_PARAM=${module.deal_pipeline.agent_model_param}
    ASSISTANT_MODEL_ID=${var.agent_model_id}
    # Local dev reads the corpus from disk. The deployed console reads the S3 copy instead; set
    # PIPELINE_SAMPLES_PREFIX=${module.deal_pipeline.samples_prefix} to exercise that path locally.
    SAMPLE_EMAILS_DIR=${local.sample_emails_dir}
    PIPELINE_SKILLS_PREFIX=${module.deal_pipeline.skills_prefix}
    PARSER_PROMPT_KEY=${module.deal_pipeline.parser_prompt_key}
  EOT
}
