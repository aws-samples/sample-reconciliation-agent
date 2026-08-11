output "enabled" {
  value = var.enabled
}

output "provider_arn" {
  value = try(data.external.oauth_provider_info[0].result.provider_arn, "")
}

output "callback_url_ssm_param" {
  value = var.enabled ? aws_ssm_parameter.callback_url[0].name : ""
}

output "target_name" {
  value = var.enabled ? local.target_name : ""
}
