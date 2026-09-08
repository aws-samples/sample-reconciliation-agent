output "enabled" {
  value = var.enabled
}

output "provider_arn" {
  value = var.enabled ? aws_cloudformation_stack.oauth_provider[0].outputs["CredentialProviderArn"] : ""
}

output "callback_url_ssm_param" {
  value = var.enabled ? aws_ssm_parameter.callback_url[0].name : ""
}

output "target_name" {
  value = var.enabled ? local.target_name : ""
}
