output "prefix" {
  description = "The SSM path the parameters live under. Hand this to the console as CONSOLE_SETTINGS_PREFIX so the reader and the writer agree on the layout."
  value       = var.prefix
}

output "parameter_arn_prefix" {
  description = "ARN of the prefix itself (arn:aws:ssm:<region>:<account>:parameter<prefix>). A grant needs this AND \"<this>/*\": GetParametersByPath authorizes on the path, the other calls on the parameters under it."
  value       = local.parameter_arn_prefix
}

output "parameter_names" {
  description = "Full names of the parameters this apply creates -- every setting whose seed was non-blank."
  value       = sort([for p in aws_ssm_parameter.setting : p.name])
}

output "skipped_settings" {
  description = "Relative keys whose seed was blank, so no parameter was created. The console resolves these from the environment until an operator saves a value in the UI, which creates the parameter."
  value       = local.skipped
}
