output "distribution_domain" {
  description = "Public entry-point host: the CloudFront domain in public mode, or the internal ALB DNS in private mode (no CloudFront). Feed into the OIDC app's callback/logout URLs."
  value       = var.private_vpc ? aws_lb.this.dns_name : aws_cloudfront_distribution.this[0].domain_name
}

# The redirect URI has to be registered on the Okta app by an org admin — an out-of-band step
# Terraform cannot perform, because the IdP is not an AWS resource. So compute the exact string to
# register and surface it, rather than leaving the operator to reconstruct it from the distribution
# domain.
output "okta_redirect_uri_to_register" {
  description = "Exact URL to add to the Okta OIDC app's Sign-in redirect URIs. When okta_redirect_uri is pinned this is that value; otherwise it is what the browser will derive from this deployment's public host — and it will change if the distribution is recreated. Empty when auth_provider != okta."
  value = var.auth_provider != "okta" ? "" : (
    var.okta_redirect_uri != "" ? var.okta_redirect_uri : (
      var.private_vpc
      ? "https://${aws_lb.this.dns_name}/login/callback"
      : "https://${aws_cloudfront_distribution.this[0].domain_name}/login/callback"
    )
  )
}

output "okta_redirect_uri_is_pinned" {
  description = "False means the callback URL is derived from the browser origin and will drift when the CloudFront domain changes — set okta_redirect_uri to stop that."
  value       = var.okta_redirect_uri != ""
}

# The two URLs a Cognito app client has to have registered for THIS deployment, composed here rather
# than in the root because the paths are the frontend's own contract, not the root's:
#   * the callback is /callback (src/lib/auth/cognito-pkce.ts, COGNITO_CALLBACK_PATH);
#   * the sign-out target is the bare ORIGIN, because that module sends window.location.origin as
#     logout_uri and Cognito compares the string EXACTLY -- a registered "https://host/" does not
#     match "https://host", and the symptom is an error page instead of a redirect after sign-out.
# Unlike Okta's, these are not an out-of-band step: the root feeds them straight into the Cognito
# callback patch, which registers them on the client in the same apply that creates the distribution.
output "cognito_callback_url" {
  description = "The OAuth redirect URL to register on the Cognito app client for this deployment: the pinned cognito_redirect_uri when set, otherwise this deployment's public host with /callback. Empty when auth_provider != cognito."
  value = var.auth_provider != "cognito" ? "" : (
    var.cognito_redirect_uri != "" ? var.cognito_redirect_uri : (
      var.private_vpc
      ? "https://${aws_lb.this.dns_name}/callback"
      : "https://${aws_cloudfront_distribution.this[0].domain_name}/callback"
    )
  )
}

output "cognito_logout_url" {
  description = "The sign-out redirect URL to register on the Cognito app client: this deployment's public ORIGIN with no path and no trailing slash. Empty when auth_provider != cognito."
  value = var.auth_provider != "cognito" ? "" : (
    var.private_vpc
    ? "https://${aws_lb.this.dns_name}"
    : "https://${aws_cloudfront_distribution.this[0].domain_name}"
  )
}

output "distribution_id" {
  description = "CloudFront distribution id (empty in private mode — no CloudFront)."
  value       = var.private_vpc ? "" : aws_cloudfront_distribution.this[0].id
}

output "web_acl_arn" {
  description = "ARN of the CloudFront-scoped WAF web ACL guarding the distribution (empty in private mode — no CloudFront, so no ACL). Use with `aws wafv2 get-web-acl` to verify rule actions."
  value       = var.private_vpc ? "" : aws_wafv2_web_acl.frontend[0].arn
}

output "alb_dns" {
  description = "ALB DNS (CloudFront origin in public mode; the direct entry point in private mode)."
  value       = aws_lb.this.dns_name
}

output "is_private" {
  description = "True when the frontend is deployed in private-VPC mode (no CloudFront / no public endpoints)."
  value       = var.private_vpc
}

# The console container's environment as a name => value map, READ BACK from the task definition
# this module renders rather than rebuilt from the inputs. The recon root renders a laptop's
# chatbot-app/frontend/.env.local from it (output frontend_env_local), so the laptop and the
# container cannot disagree on a single value: whatever the task carries is what the file says.
# Sensitive because EMAIL_CONFIRMATION_TOKEN is in it.
output "task_environment" {
  description = "Every environment variable of the console container, name => value, exactly as the ECS task definition carries it: recon, console-wide and -- when pipeline_enabled -- the pipeline's. Feeds the recon root's frontend_env_local output."
  sensitive   = true
  value       = { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }
}
