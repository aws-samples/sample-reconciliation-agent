output "idp_hook_function_arn" {
  description = "The ingest hook. Invoked by this stack's own EventBridge rule when idp_state_machine_arn is set; only needs wiring on the IDP side when it is not."
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
    # Listed only when this stack has NOT been told which state machine to watch. With
    # idp_state_machine_arn set, the rule in the idp-hook module is the trigger and the IDP-side hook
    # setting must stay unset -- both would fire the hook on the same document. Telling an operator to
    # set it unconditionally is how the platform ends up ingesting every notice twice.
    var.idp_state_machine_arn != "" ? "" : "IDP: nothing invokes the ingest hook. Either set idp_state_machine_arn to the document-processing state machine (preferred -- this stack then owns the rule), or set IDP's PostProcessingLambdaHookFunctionArn = ${module.idp_hook.hook_function_arn}. Until one of the two is done, uploads complete and the notices table stays empty with no error anywhere.",
    var.auth_provider != "okta" ? "" : "Okta: add '${module.frontend.okta_redirect_uri_to_register}' to the OIDC app's Sign-in redirect URIs (and 'https://${module.frontend.distribution_domain}' to Sign-out redirect URIs).",
    var.auth_provider != "okta" || module.frontend.okta_redirect_uri_is_pinned ? "" : "Okta: the callback URL above is DERIVED from the current CloudFront domain and will change if the distribution is recreated, breaking login. Pin it by setting the okta_redirect_uri variable to that value.",
  ])
}
