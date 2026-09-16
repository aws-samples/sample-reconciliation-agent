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
