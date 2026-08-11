output "items_table" {
  description = "Name of the recon-items DynamoDB table."
  value       = aws_dynamodb_table.items.name
}

output "items_table_arn" {
  description = "ARN of the recon-items DynamoDB table."
  value       = aws_dynamodb_table.items.arn
}

output "items_stream_arn" {
  description = "DynamoDB stream ARN for the recon-items table (feeds Tier-1)."
  value       = aws_dynamodb_table.items.stream_arn
}

output "cases_table_arn" {
  description = "ARN of the recon-cases DynamoDB table."
  value       = aws_dynamodb_table.cases.arn
}

output "audit_table_arn" {
  description = "ARN of the recon-audit DynamoDB table."
  value       = aws_dynamodb_table.audit.arn
}

output "assets_bucket_arn" {
  description = "ARN of the assets S3 bucket."
  value       = aws_s3_bucket.assets.arn
}

output "cases_table" {
  description = "Name of the recon-cases DynamoDB table."
  value       = aws_dynamodb_table.cases.name
}

output "audit_table" {
  description = "Name of the recon-audit DynamoDB table."
  value       = aws_dynamodb_table.audit.name
}

output "raw_bucket" {
  description = "Name of the raw source-document S3 bucket."
  value       = aws_s3_bucket.raw.bucket
}

output "assets_bucket" {
  description = "Name of the assets S3 bucket (skills catalog, KB seed, built SPA)."
  value       = aws_s3_bucket.assets.bucket
}

output "user_pool_id" {
  description = "Cognito user pool id."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN (JWT authorizer issuer)."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "Cognito user pool endpoint (JWT issuer base)."
  value       = aws_cognito_user_pool.this.endpoint
}

output "spa_client_id" {
  description = "Cognito SPA app client id (public, PKCE)."
  value       = aws_cognito_user_pool_client.spa.id
}

output "hosted_ui_domain" {
  description = "Cognito Hosted UI domain prefix."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "lessons_table" {
  description = "Name of the recon-lessons DynamoDB table."
  value       = aws_dynamodb_table.lessons.name
}

output "lessons_table_arn" {
  description = "ARN of the recon-lessons table."
  value       = aws_dynamodb_table.lessons.arn
}

output "tier1_enabled_param" {
  description = "Name of the SSM parameter toggling the deterministic Tier-1 route."
  value       = aws_ssm_parameter.tier1_enabled.name
}

output "tier1_enabled_param_arn" {
  description = "ARN of the Tier-1 toggle SSM parameter."
  value       = aws_ssm_parameter.tier1_enabled.arn
}

output "auto_resolve_param" {
  description = "Name of the SSM parameter holding the auto-resolve confidence threshold."
  value       = aws_ssm_parameter.auto_resolve_threshold.name
}

output "auto_resolve_param_arn" {
  value = aws_ssm_parameter.auto_resolve_threshold.arn
}

output "harness_config_version_param" {
  description = "SSM parameter name of the active harness config version pointer."
  value       = aws_ssm_parameter.harness_config_version.name
}

output "harness_config_version_param_arn" {
  value = aws_ssm_parameter.harness_config_version.arn
}

output "agent_backend_param" {
  description = "SSM parameter name of the runtime agent-backend selector (runtime|harness)."
  value       = aws_ssm_parameter.agent_backend.name
}

output "agent_backend_param_arn" {
  value = aws_ssm_parameter.agent_backend.arn
}

output "comment_requirement_param" {
  description = "SSM parameter holding the decision-comment requirement mode."
  value       = aws_ssm_parameter.comment_requirement.name
}

output "comment_requirement_param_arn" {
  value = aws_ssm_parameter.comment_requirement.arn
}
