# Every value the frontend's .env.local needs (design §11), one output each, plus `env_local`
# which renders the whole file:
#
#   terraform output -raw env_local > ../../../chatbot-app/frontend/.env.local
#
# The three PIPELINE_/NEXT_PUBLIC_ constants and SAMPLE_EMAILS_DIR are application settings the
# design fixes for local development, not infrastructure. They are outputs anyway so the rendered
# file is complete and nothing has to be typed by hand.

locals {
  # Anonymous API access is the local-dev mode (design §9): the BFF runs on the developer's
  # laptop with the developer's credentials and there is no IdP in this deployment.
  pipeline_allow_anonymous_api = "true"
  # Group name the BFF checks for approve/reject, skill writes, memory delete and config PUT once
  # an IdP is wired up. Irrelevant while anonymous access is on, but the design fixes the name.
  pipeline_admin_group = "deal-desk-admins"
  # The frontend's auth-provider switch; the design keeps the existing app's default.
  next_public_auth_provider = "entra"
  # Relative to chatbot-app/frontend, where `npm run dev` runs.
  sample_emails_dir = "../../data/deal-emails"
}

output "pipeline_allow_anonymous_api" {
  value = local.pipeline_allow_anonymous_api
}

output "pipeline_admin_group" {
  value = local.pipeline_admin_group
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

output "skills_prefix" {
  value = module.deal_pipeline.skills_prefix
}

output "parser_prompt_key" {
  value = module.deal_pipeline.parser_prompt_key
}

output "env_local" {
  description = "Complete chatbot-app/frontend/.env.local body (design §11). Use with `terraform output -raw env_local`."
  value       = <<-EOT
    PIPELINE_ALLOW_ANONYMOUS_API=${local.pipeline_allow_anonymous_api}
    PIPELINE_ADMIN_GROUP=${local.pipeline_admin_group}
    NEXT_PUBLIC_AUTH_PROVIDER=${local.next_public_auth_provider}
    AWS_REGION=${module.deal_pipeline.region}
    ASSETS_BUCKET=${module.deal_pipeline.assets_bucket}
    EMAILS_TABLE=${module.deal_pipeline.emails_table}
    DEALS_TABLE=${module.deal_pipeline.deals_table}
    SKILL_PROPOSALS_TABLE=${module.deal_pipeline.skill_proposals_table}
    KNOWLEDGE_MEMORY_ID=${module.deal_pipeline.knowledge_memory_id}
    CHAT_MEMORY_ID=${module.deal_pipeline.chat_memory_id}
    PARSER_FUNCTION=${module.deal_pipeline.parser_function_name}
    OMS_UPLOAD_FUNCTION=${module.deal_pipeline.oms_upload_function_name}
    AGENT_MODEL_PARAM=${module.deal_pipeline.agent_model_param}
    ASSISTANT_MODEL_ID=${var.agent_model_id}
    SAMPLE_EMAILS_DIR=${local.sample_emails_dir}
    SKILLS_PREFIX=${module.deal_pipeline.skills_prefix}
    PARSER_PROMPT_KEY=${module.deal_pipeline.parser_prompt_key}
  EOT
}
