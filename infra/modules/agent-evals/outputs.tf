output "evaluator_arn" {
  description = "ARN of the analyst-agreement evaluator."
  value       = aws_bedrockagentcore_evaluator.agreement.evaluator_arn
}

output "evaluator_id" {
  description = "Evaluator ID (used in batch evaluations + online config)."
  value       = aws_bedrockagentcore_evaluator.agreement.evaluator_id
}

output "evaluator_lambda_arn" {
  description = "ARN of the evaluator Lambda. Needed by the BFF task role: StartBatchEvaluation invokes it under a FAS derived from that role, so the grant has to be identity-based."
  value       = aws_lambda_function.evaluator.arn
}

output "online_eval_config_names" {
  description = "Names of the online evaluation configs, keyed by backend id (one config per backend)."
  value       = { for k, cfg in aws_bedrockagentcore_online_evaluation_config.this : k => cfg.online_evaluation_config_name }
}

output "results_log_group_prefix" {
  description = "Name prefix of the service-generated results log groups (one per config: <prefix>_<backend>-<suffix>). The BFF discovers the actual groups via DescribeLogGroups."
  value       = "/aws/bedrock-agentcore/evaluations/results/${local.config_name}"
}

output "eval_exec_role_arn" {
  description = "Evaluation execution role ARN (needed by BFF for StartBatchEvaluation)."
  value       = aws_iam_role.eval_exec.arn
}
