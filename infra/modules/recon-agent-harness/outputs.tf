output "harness_arn" {
  description = "ARN of the managed AgentCore Harness (fed to the agent-worker as HARNESS_ARN)."
  value       = data.external.harness_arn.result.harness_arn
}

output "harness_name" {
  description = "Harness name (stable identifier used by manage_harness.py)."
  value       = local.harness_name
}

output "execution_role_arn" {
  description = "Harness execution role ARN."
  value       = aws_iam_role.harness.arn
}

output "harness_runtime_log_group" {
  description = "CloudWatch log group of the runtime the harness materializes (holds the OTel gen-ai event records the online eval configs must list as a data source; '' until the harness runtime exists)."
  value       = data.external.harness_arn.result.harness_runtime_log_group
}
