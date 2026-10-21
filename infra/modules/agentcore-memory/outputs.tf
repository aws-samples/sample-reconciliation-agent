output "memory_id" {
  description = "AgentCore Memory id (MEMORY_ID / KNOWLEDGE_MEMORY_ID / CHAT_MEMORY_ID in the consumers' environments)."
  value       = aws_bedrockagentcore_memory.this.id
}

output "memory_arn" {
  description = "ARN of the memory, for CreateEvent/Retrieve IAM grants (grant \"<arn>\" and \"<arn>/*\")."
  value       = aws_bedrockagentcore_memory.this.arn
}

output "execution_role_arn" {
  description = "ARN of the execution role the memory carries: the one created here, or the one passed in. A second memory sharing the role takes this with create_execution_role = false."
  value       = local.execution_role_arn
}

output "strategy_id" {
  description = "Id of the extraction strategy, or null when no strategy is configured."
  value       = var.strategy == null ? null : aws_bedrockagentcore_memory_strategy.this[0].memory_strategy_id
}
