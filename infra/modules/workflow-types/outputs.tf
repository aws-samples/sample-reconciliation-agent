output "workflow_types_table_name" {
  description = "Name of the workflow-types table (what may be uploaded, and where each kind goes)."
  value       = aws_dynamodb_table.workflow_types.name
}

output "workflow_types_table_arn" {
  description = "ARN of the workflow-types table, for the Config tab's read+write grant."
  value       = aws_dynamodb_table.workflow_types.arn
}
