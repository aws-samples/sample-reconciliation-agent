output "idp_hook_function_arn" {
  description = "Set this as IDP's PostProcessingLambdaHookFunctionArn (IDP-side, separate config)."
  value       = module.idp_hook.hook_function_arn
}

output "frontend_url" {
  description = "Public entry point for the recon console."
  value       = "https://${module.frontend.distribution_domain}"
}

output "okta_redirect_uri_to_register" {
  description = "Exact URL that must appear in the Okta OIDC app's Sign-in redirect URIs. Empty when auth_provider != okta."
  value       = module.frontend.okta_redirect_uri_to_register
}

# Both remaining manual steps live in systems Terraform does not own (an IDP stack and an Okta
# org), so an apply can succeed and the platform still not work. Live QA lost time to exactly that
# on the Okta callback (P0-1), so enumerate the out-of-band steps in the apply output instead of
# leaving them to tribal knowledge.
output "post_deploy_checklist" {
  description = "Out-of-band steps Terraform cannot perform. Review after every apply."
  value = compact([
    "IDP: set PostProcessingLambdaHookFunctionArn = ${module.idp_hook.hook_function_arn}",
    var.auth_provider != "okta" ? "" : "Okta: add '${module.frontend.okta_redirect_uri_to_register}' to the OIDC app's Sign-in redirect URIs (and 'https://${module.frontend.distribution_domain}' to Sign-out redirect URIs).",
    var.auth_provider != "okta" || module.frontend.okta_redirect_uri_is_pinned ? "" : "Okta: the callback URL above is DERIVED from the current CloudFront domain and will change if the distribution is recreated, breaking login. Pin it by setting the okta_redirect_uri variable to that value.",
  ])
}
