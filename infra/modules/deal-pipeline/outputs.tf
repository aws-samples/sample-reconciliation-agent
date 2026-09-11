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
  value       = aws_bedrockagentcore_memory.knowledge.id
}

output "knowledge_memory_arn" {
  value = aws_bedrockagentcore_memory.knowledge.arn
}

output "chat_memory_id" {
  description = "AgentCore Memory the assistant writes chat turns to (events only, 7-day expiry)."
  value       = aws_bedrockagentcore_memory.chat.id
}

output "chat_memory_arn" {
  value = aws_bedrockagentcore_memory.chat.arn
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
