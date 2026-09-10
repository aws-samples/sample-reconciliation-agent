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

output "intake_private_api_url" {
  description = "Base URL of the VPC-only intake REST API (POST <url>/items). Empty unless private_vpc = true. Reachable only through the execute-api interface endpoint — from the VPC, a VPN or Direct Connect, never the internet."
  value       = module.intake.private_api_invoke_url
}

# Both manual steps live in systems Terraform does not own (an IDP stack and an Okta org), so an
# apply can succeed and the platform still not work — an unregistered Okta callback breaks login
# with no sign of it in the plan. Enumerate the out-of-band steps in the apply output rather than
# leaving them to tribal knowledge.
output "post_deploy_checklist" {
  description = "Out-of-band steps Terraform cannot perform. Review after every apply."
  value = compact([
    # Listed only when this stack has NOT been told which state machine to watch. With
    # idp_state_machine_arn set, the rule in the idp-hook module is the trigger and the IDP-side hook
    # setting must stay unset -- both would fire the hook on the same document, ingesting every
    # notice twice. So the two wiring options are mutually exclusive, never both.
    var.idp_state_machine_arn != "" ? "" : "IDP: nothing invokes the ingest hook. Either set idp_state_machine_arn to the document-processing state machine (preferred -- this stack then owns the rule), or set IDP's PostProcessingLambdaHookFunctionArn = ${module.idp_hook.hook_function_arn}. Until one of the two is done, uploads complete and the notices table stays empty with no error anywhere.",
    var.auth_provider != "okta" ? "" : "Okta: add '${module.frontend.okta_redirect_uri_to_register}' to the OIDC app's Sign-in redirect URIs (and 'https://${module.frontend.distribution_domain}' to Sign-out redirect URIs).",
    var.auth_provider != "okta" || module.frontend.okta_redirect_uri_is_pinned ? "" : "Okta: the callback URL above is DERIVED from the current CloudFront domain and will change if the distribution is recreated, breaking login. Pin it by setting the okta_redirect_uri variable to that value.",
    # The private intake API's two gaps. Both are silent: a rejected request writes no log line
    # anywhere, and the SigV4 posture is not obvious from the URL alone.
    !var.private_vpc ? "" : "Private intake API: access logging is OFF because REST-API CloudWatch logging needs an account-level role this stack deliberately does not own (it is a per-account singleton). A request rejected by the resource policy or by IAM leaves NO trace. To enable: create a role trusting apigateway.amazonaws.com with AmazonAPIGatewayPushToCloudWatchLogs, run 'aws apigateway update-account --patch-operations op=replace,path=/cloudwatchRoleArn,value=<role-arn>', then add access_log_settings to aws_api_gateway_stage.v1 in modules/intake/private_api.tf.",
    !var.private_vpc ? "" : "Private intake API: it is authorized with AWS_IAM (SigV4), not a bearer token, so a caller needs credentials plus execute-api:Invoke on ${module.intake.private_api_id}. There is no IdP in that path on purpose — a Lambda authorizer verifying Okta tokens would have to fetch Okta's JWKS from inside the VPC and would fail closed once the NAT is removed.",
  ])
}
