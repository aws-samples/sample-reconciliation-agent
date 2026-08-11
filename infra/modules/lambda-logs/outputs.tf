output "log_group_names" {
  description = "Names of the created CloudWatch log groups."
  value       = [for lg in aws_cloudwatch_log_group.lambda : lg.name]
}
