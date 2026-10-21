output "assets_bucket" {
  description = "Name of the single S3 bucket (seeds, emails, staging CSVs, OMS staging)."
  value       = aws_s3_bucket.assets.bucket
}

output "assets_bucket_arn" {
  value = aws_s3_bucket.assets.arn
}

output "emails_table" {
  value = aws_dynamodb_table.emails.name
}

output "deals_table" {
  value = aws_dynamodb_table.deals.name
}

output "skill_proposals_table" {
  value = aws_dynamodb_table.skill_proposals.name
}

output "knowledge_memory_id" {
  description = "AgentCore Memory holding the edge_cases strategy (parser recall, assistant save_memory, Memory Manager)."
  value       = module.knowledge_memory.memory_id
}

output "knowledge_memory_arn" {
  value = module.knowledge_memory.memory_arn
}

output "chat_memory_id" {
  description = "AgentCore Memory the assistant writes chat turns to (events only, 7-day expiry)."
  value       = module.chat_memory.memory_id
}

output "chat_memory_arn" {
  value = module.chat_memory.memory_arn
}

output "parser_function_name" {
  description = "Parsing-agent Lambda; the BFF async-invokes it on email intake and reparse."
  value       = aws_lambda_function.parser.function_name
}

output "parser_function_arn" {
  value = aws_lambda_function.parser.arn
}

output "oms_upload_function_name" {
  description = "Mock OMS validator Lambda; the BFF invokes it synchronously on approve."
  value       = aws_lambda_function.oms_upload.function_name
}

output "oms_upload_function_arn" {
  value = aws_lambda_function.oms_upload.arn
}

output "agent_model_param" {
  description = "SSM parameter name holding the runtime-selected parser model id."
  value       = aws_ssm_parameter.agent_model_id.name
}

output "agent_model_param_arn" {
  value = aws_ssm_parameter.agent_model_id.arn
}

output "skills_prefix" {
  description = "S3 prefix of the seeded skills (also the parser's SKILLS_PREFIX)."
  value       = local.skills_prefix
}

output "parser_prompt_key" {
  description = "S3 key of the parser system prompt (also the parser's PARSER_PROMPT_KEY)."
  value       = local.parser_prompt_key
}

output "samples_prefix" {
  description = "S3 prefix of the seeded sample-email corpus (the BFF's PIPELINE_SAMPLES_PREFIX when it reads samples from S3 rather than from disk)."
  value       = local.samples_prefix
}

output "region" {
  value = local.region
}

output "account_id" {
  value = local.account_id
}

# The console wiring (console.tf), for modules/frontend-ecs's app_wiring input. The recon root passes
# both as app_wiring.pipeline; a developer's laptop gets the same values through that root's
# frontend_env_local output, which reads them back off the rendered task definition.
output "console_environment" {
  description = "Environment the console container needs for the pipeline BFF, as { name, value } entries: PIPELINE_ASSETS_BUCKET, PIPELINE_AGENT_MODEL_PARAM, PIPELINE_SKILLS_PREFIX, EMAILS_TABLE, DEALS_TABLE, SKILL_PROPOSALS_TABLE, KNOWLEDGE_MEMORY_ID, CHAT_MEMORY_ID, PARSER_FUNCTION, OMS_UPLOAD_FUNCTION, ASSISTANT_MODEL_ID, PARSER_PROMPT_KEY, PIPELINE_SAMPLES_PREFIX."
  value       = local.console_environment
}

output "console_task_statements" {
  description = "IAM statements the console task role needs to reach this module's resources with exactly the verbs the pipeline BFF issues, one jsonencode()d statement per entry (statements differ in shape, so no single HCL type holds them; frontend-ecs decodes them into its policy unchanged)."
  value       = [for s in local.console_task_statements : jsonencode(s)]
}

output "editable_seeds" {
  description = "The create-only seeds (every skills/<name>/SKILL.md and the parser prompt) as bucket key => { path = file to read, source = repo-relative label }, for the recon root's aws_lambda_invocation.pipeline_seed_push. Derived from the same locals as the seed modules, so the two cannot disagree."
  value       = local.editable_seeds
}
