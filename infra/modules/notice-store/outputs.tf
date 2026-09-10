output "notices_table_name" {
  description = "Name of the recon-notices table (the actual side)."
  value       = aws_dynamodb_table.notices.name
}

output "notices_table_arn" {
  description = "ARN of the recon-notices table, for IAM grants."
  value       = aws_dynamodb_table.notices.arn
}

output "notices_table_index_arn" {
  description = "ARN of the idp-document-index GSI, for the console's IAM grant. A GSI Query is a distinct resource from the table ARN above, so dynamodb:Query against this index needs its own <table-arn>/index/idp-document-index entry in the console task policy alongside the table ARN -- which is how modules/frontend-ecs consumes it. The name is composed here rather than in the consumer so the module that creates the index owns its name."
  value       = "${aws_dynamodb_table.notices.arn}/index/idp-document-index"
}

output "notice_tool_lambda_arn" {
  description = "ARN of the search_notices query Lambda, for the gateway target."
  value       = aws_lambda_function.notice_query.arn
}

output "notice_tool_lambda_name" {
  description = "Name of the search_notices query Lambda, for the gateway invoke permission."
  value       = aws_lambda_function.notice_query.function_name
}

output "notice_search_table_name" {
  description = "Name of the recon-notice-search inverted-index table. The IDP hook writes it and the search_notices Lambda reads it; both take the name from here rather than composing it, so the module that creates the table owns its name."
  value       = aws_dynamodb_table.notice_search.name
}

output "notice_search_table_arn" {
  description = "ARN of the recon-notice-search table, for the IDP hook's write grant. No index ARN companion is needed -- the table has no GSI, because it IS the index and is only ever read by its own keys."
  value       = aws_dynamodb_table.notice_search.arn
}
