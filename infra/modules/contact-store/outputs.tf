output "contacts_table_name" {
  description = "Name of the contacts table (who the platform may email)."
  value       = aws_dynamodb_table.contacts.name
}

output "contacts_table_arn" {
  description = "ARN of the contacts table, for IAM grants."
  value       = aws_dynamodb_table.contacts.arn
}

output "templates_table_name" {
  description = "Name of the email-templates table (the wording the platform may send)."
  value       = aws_dynamodb_table.templates.name
}

output "templates_table_arn" {
  description = "ARN of the email-templates table, for IAM grants."
  value       = aws_dynamodb_table.templates.arn
}

output "contact_tool_lambda_arn" {
  description = "ARN of the list_contacts/list_templates query Lambda, for both gateway targets."
  value       = aws_lambda_function.contact_query.arn
}

output "contact_tool_lambda_name" {
  description = "Name of the query Lambda, for the gateway invoke permission."
  value       = aws_lambda_function.contact_query.function_name
}

output "notify_contact_id" {
  description = <<-EOT
    Contact id of the seeded internal-notification recipient, for NOTIFY_CONTACT_ID on the
    senders (Tier-1 auto-resolve, the agent runtime). This is an ID, not an address: the
    address is resolved from the table at send time, which is what makes deactivating the
    contact in the Config tab stop the mail without a redeploy.
  EOT
  value       = local.notify_contact_id
}
