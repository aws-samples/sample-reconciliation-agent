output "harness_arn" {
  description = "ARN of the managed AgentCore Harness (fed to the agent-worker as HARNESS_ARN)."
  value       = aws_cloudformation_stack.harness.outputs["HarnessArn"]
}

output "harness_name" {
  description = "Harness name (stable identifier; the only create-only property on the resource)."
  value       = local.harness_name
}

output "execution_role_arn" {
  description = "Harness execution role ARN."
  value       = aws_iam_role.harness.arn
}

output "harness_runtime_log_group" {
  description = "CloudWatch log group of the runtime the harness materializes (holds the OTel gen-ai event records the online eval configs must list as a data source)."
  # Derived from the runtime id rather than looked up: the id is a readOnly property of the harness,
  # so the stack output already carries it, and the group name is a fixed pattern around it — no
  # ListAgentRuntimes call, and nothing to paginate.
  value = "/aws/bedrock-agentcore/runtimes/${aws_cloudformation_stack.harness.outputs["AgentRuntimeId"]}-DEFAULT"
}
