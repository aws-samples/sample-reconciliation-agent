# ⚠️ NOTHING HERE IS MARKED SENSITIVE, AND THAT IS A DECISION — PLEASE DO NOT "TIDY" IT LATER.
#
# A user pool id, a hosted-UI domain and a PUBLIC app client id are not secrets. The client id is
# compiled into the browser bundle as a NEXT_PUBLIC_* build argument and appears in the query string
# of every authorize request; the pool id appears in the issuer of every token the console verifies
# and in the JWKS URL it fetches. Marking them sensitive would not conceal anything from anyone: it
# would only stop them being printed by `terraform output`, force nonsensitive() into the root's
# .env.local rendering and the module tests' error messages, and teach a reader that these values are
# secret when the security of the flow does not rest on them at all (PKCE is what replaces the
# secret this client deliberately does not have).
#
# There is no output for a client SECRET because there is none: generate_secret = false.

output "user_pool_id" {
  description = "Cognito user pool id, e.g. us-east-1_ABC123def. Handed to the console as COGNITO_USER_POOL_ID; the BFF derives the issuer and the JWKS URL from it and the region."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "ARN of the user pool. The only thing scoped to it outside this module is the deploy-actions actor's callback-patch grant (cognito-idp:DescribeUserPoolClient / UpdateUserPoolClient)."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "The pool's endpoint host, cognito-idp.<region>.amazonaws.com/<pool-id> — WITHOUT a scheme. The JWT `iss` is \"https://\" prefixed onto this, which is exactly how the root builds local.oidc_issuer for the intake API's authorizer."
  value       = aws_cognito_user_pool.this.endpoint
}

output "spa_client_id" {
  description = "App client id of the public PKCE client. This is the `aud` claim the intake API's JWT authorizer and the BFF both require, and the client_id the browser sends to the hosted UI."
  value       = aws_cognito_user_pool_client.spa.id
}

output "hosted_ui_domain" {
  description = "Full hosted-UI host, <prefix>.auth.<region>.amazoncognito.com, with no scheme and no trailing slash. This is COGNITO_HOSTED_UI / NEXT_PUBLIC_COGNITO_HOSTED_UI; cognito-pkce.ts also accepts it with an https:// prefix, but the bare host is what this outputs."
  value       = "${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

output "hosted_ui_url" {
  description = "The same host as an https:// origin, for the post-deploy checklist and for an operator who wants to open the sign-in page directly."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

output "hosted_ui_prefix" {
  description = "Just the domain prefix, echoed back. Useful when composing a different host form; the globally-unique name a deployment claimed."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "group_names" {
  description = "The five group names this pool created, keyed by the role the console reads them for (recon-access, recon-admin, pipeline-access, pipeline-admin, console-admin). The root passes these same strings to the console so the group in the token is the group the proxy checks."
  value       = { for key, group in aws_cognito_user_group.console : key => group.name }
}

output "group_names_list" {
  description = "The same five names, sorted, for an apply log or a checklist line that just needs to say which groups exist."
  value       = sort([for group in aws_cognito_user_group.console : group.name])
}
