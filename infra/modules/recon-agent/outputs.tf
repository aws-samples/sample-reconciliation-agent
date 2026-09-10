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

# The managed pair below is the module's only knowledge base — there is no customer-managed one to
# expose alongside it. See the environment root's kb_ingest_targets note for why.

output "managed_kb_id" {
  description = "Bedrock MANAGED Knowledge Base id (the one the Gateway connector target wraps)."
  value       = aws_bedrockagent_knowledge_base.managed.id
}

output "managed_kb_arn" {
  description = "ARN of the MANAGED Knowledge Base (for the gateway role's bedrock:Retrieve grant)."
  value       = aws_bedrockagent_knowledge_base.managed.arn
}

output "managed_kb_data_source_id" {
  description = "MANAGED Knowledge Base data source id (for triggering ingestion jobs). Gated on the data source reaching AVAILABLE."
  # ⚠️ Read THROUGH the readiness gate ON PURPOSE, not straight off the data source.
  # CreateDataSource is async for a managed KB (CREATING -> AVAILABLE, ~2-5 min) and an ingestion
  # job started against a CREATING data source fails. The consumer is the environment's KB
  # ingestion, which cannot depends_on a resource inside this module — so the dependency has to
  # travel through this output. Pointing it at aws_bedrockagent_data_source.managed.data_source_id
  # instead would silently drop the wait.
  #
  # The gate is an aws_lambda_invocation, which has no `triggers`, so the id is read back out of its
  # `input`. Nothing can read this output until that wait has returned successfully.
  value = jsondecode(aws_lambda_invocation.managed_kb_data_source_available.input).data_source_id
}

output "kb_connector_target_id" {
  description = "Gateway target id of the `managed-kb` connector target (for readiness polling and tools/list probes)."
  value       = aws_cloudformation_stack.kb_connector_target.outputs["TargetId"]
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
