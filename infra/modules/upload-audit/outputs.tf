output "uploads_table_name" {
  description = "Name of the upload-submissions table."
  value       = aws_dynamodb_table.uploads.name
}

output "uploads_table_arn" {
  description = "ARN of the upload-submissions table, for the BFF's read+write grant."
  value       = aws_dynamodb_table.uploads.arn
}

output "uploads_table_index_arn" {
  description = "ARN of the by_recency index. A Query on an index needs its OWN ARN granted; the table ARN alone answers AccessDenied."
  value       = "${aws_dynamodb_table.uploads.arn}/index/by_recency"
}
