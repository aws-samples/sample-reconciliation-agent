output "queue_arn" {
  description = "ARN of the debounce queue, for wiring or manual re-drive."
  value       = aws_sqs_queue.ingest.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue. A message here means ingestion is stuck and no upload is becoming searchable."
  value       = aws_sqs_queue.ingest_dlq.url
}

output "function_name" {
  description = "Name of the ingestion Lambda, for reading its logs."
  value       = aws_lambda_function.kb_ingest.function_name
}
