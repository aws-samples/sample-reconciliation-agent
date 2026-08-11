output "runtime_arn" {
  description = "ARN of the recon-agent AgentCore runtime (fed to the Tier-1 and BFF modules)."
  value       = aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn
}

output "runtime_name" {
  description = "Runtime name (basis of the OTel service.name '<runtime_name>.DEFAULT' used by the online eval filter)."
  value       = aws_bedrockagentcore_agent_runtime.this.agent_runtime_name
}

output "gateway_url" {
  description = "AgentCore Gateway MCP endpoint URL."
  value       = aws_bedrockagentcore_gateway.this.gateway_url
}

output "gateway_id" {
  description = "AgentCore Gateway id."
  value       = aws_bedrockagentcore_gateway.this.gateway_id
}

output "gateway_arn" {
  description = "Egress tools gateway ARN (pinned in the gated Cedar policies)."
  value       = aws_bedrockagentcore_gateway.this.gateway_arn
}

output "policy_engine_name" {
  description = "AgentCore Policy engine name enforcing the confidence gate (Config tab edits its gated policies)."
  value       = local.policy_engine_name
}

output "memory_id" {
  description = "AgentCore Memory id."
  value       = aws_bedrockagentcore_memory.this.id
}

output "kb_id" {
  description = "Bedrock Knowledge Base id."
  value       = aws_bedrockagent_knowledge_base.this.id
}

output "kb_data_source_id" {
  description = "Bedrock Knowledge Base data source id (for triggering ingestion jobs)."
  value       = aws_bedrockagent_data_source.kb.data_source_id
}

output "memory_arn" {
  description = "ARN of the AgentCore Memory (for CreateEvent/Retrieve IAM grants)."
  value       = aws_bedrockagentcore_memory.this.arn
}

output "ingress_gateway_url" {
  description = "Ingress gateway MCP endpoint fronting the agent (Tier-1 worker + BFF invoke via this)."
  value       = aws_bedrockagentcore_gateway.ingress.gateway_url
}

output "ingress_gateway_arn" {
  description = "Ingress gateway ARN (for InvokeGateway IAM on the callers)."
  value       = aws_bedrockagentcore_gateway.ingress.gateway_arn
}

output "runtime_log_group" {
  description = "CloudWatch log group of the AgentCore runtime (holds the OTel gen-ai event records the online eval configs must list as a data source)."
  # /aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT; the runtime id is the ARN leaf.
  value = "/aws/bedrock-agentcore/runtimes/${element(split("/", aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn), 1)}-DEFAULT"
}
