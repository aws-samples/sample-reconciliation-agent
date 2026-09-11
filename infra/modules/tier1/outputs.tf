output "worker_function_arn" {
  description = "Agent-worker Lambda ARN — the single dispatch point that honors the runtime⇄harness backend switch. The frontend BFF invokes it (async) for reject→reprocess."
  value       = aws_lambda_function.worker.arn
}

output "worker_dlq_url" {
  description = "Queue holding agent invocations that never ran — the only record that an escalated item was dropped without opening a proposal. Non-empty after a burst means the concurrency cap stayed saturated past the event age."
  value       = aws_sqs_queue.worker_dlq.url
}

output "worker_dlq_arn" {
  description = "ARN of the agent-worker dead-letter queue."
  value       = aws_sqs_queue.worker_dlq.arn
}
