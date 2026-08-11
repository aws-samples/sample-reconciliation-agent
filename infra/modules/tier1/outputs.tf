output "worker_function_arn" {
  description = "Agent-worker Lambda ARN — the single dispatch point that honors the runtime⇄harness backend switch. The frontend BFF invokes it (async) for reject→reprocess."
  value       = aws_lambda_function.worker.arn
}
