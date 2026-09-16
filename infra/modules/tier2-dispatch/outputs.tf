output "state_machine_arn" {
  description = "Tier-2 map run. Start it by hand to drain PENDING cases without waiting for the schedule."
  value       = aws_sfn_state_machine.tier2.arn
}

output "state_machine_name" {
  description = "Name of the Tier-2 state machine."
  value       = aws_sfn_state_machine.tier2.name
}

output "dispatch_function_name" {
  description = "Dispatcher Lambda. Its billed duration should be flat ~1s regardless of how long investigations take — that is the whole point of the async path, and the metric to watch."
  value       = aws_lambda_function.dispatch.function_name
}

output "collect_function_name" {
  description = "Collector Lambda (PENDING cases → S3)."
  value       = aws_lambda_function.collect.function_name
}

output "case_step_function_name" {
  description = "Guarded case-write Lambda (claim / mark-failed)."
  value       = aws_lambda_function.case_step.function_name
}

output "schedule_enabled" {
  description = "Whether the scheduled map run is live. Ships false — a merge must not start spending on Bedrock unattended."
  value       = var.schedule_enabled
}
