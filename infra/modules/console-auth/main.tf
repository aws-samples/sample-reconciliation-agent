####################################################################################
# console-auth: the console's OWN identity provider — an Amazon Cognito user pool, its hosted UI
# (managed login) domain, one public SPA app client using authorization code + PKCE, and the five
# groups the console reads out of the token's group claim.
#
# ⚠️ WHY THIS IS NOT IN modules/foundation, AND WHY THIS IS NOT THE POOL THAT WAS DELETED.
#
# A user pool used to live in modules/foundation. Upstream deleted it deliberately (commit bad0cbe,
# "Cognito-free auth") and the recon root records the reason: the pool existed ONLY to be the intake
# HTTP API's JWT issuer while the console itself signed in through Okta. That is one deployment with
# two identity providers, and the pool's own hosted UI was orphaned — nobody ever logged in to it.
# That critique was correct and this module must not recreate the shape it criticised.
#
# What is different now: this pool IS the console's login. The browser runs the code+PKCE flow
# against the hosted UI below (chatbot-app/frontend/src/lib/auth/cognito-pkce.ts), the BFF verifies
# the resulting tokens against this pool's issuer (src/lib/api-auth.ts), and the intake HTTP API's
# JWT authorizer validates the SAME issuer and the SAME audience (the root's oidc_* locals). One
# identity provider serves every door. Okta and Entra remain fully supported and selectable through
# auth_provider; when either is chosen this module is not instantiated at all.
#
# It lives in its own module rather than back in foundation so that the maintainer's module keeps the
# shape it was left in: foundation stays S3 + DynamoDB + SSM, with no identity provider in it.
#
# ⚠️ NOT AN AUTHORIZATION BOUNDARY FOR THE PRIVATE INTAKE API. modules/intake/private_api.tf stays
# SigV4-authorized. There is deliberately no IdP in that path: a Lambda authorizer verifying pool
# tokens would have to fetch this pool's JWKS from inside the VPC and would fail closed the moment
# the NAT is removed, which is exactly the deployment that API exists for.
#
# FEDERATING AN ENTERPRISE IdP: keep auth_provider = "cognito" and add a SAML or OIDC identity
# provider to this pool (aws_cognito_identity_provider), then add its name to the client's
# supported_identity_providers. The console keeps validating ONE issuer — this pool — and the
# enterprise directory becomes an upstream of it. That is the arrangement AWS documents, and it is
# strictly better than pointing the console at the enterprise IdP directly, which is what
# auth_provider = "okta" / "entra" does and what leaves this sample unrunnable without a tenant.
####################################################################################

data "aws_region" "current" {}

resource "aws_cognito_user_pool" "this" {
  #checkov:skip=CKV_AWS_39:Advanced security (threat protection) needs the Cognito Plus feature plan, which is a per-MAU charge this sample does not impose on a customer deploying it to try the console. Turn it on with a user_pool_add_ons block for a real deployment.
  name = "${var.name_prefix}-users"

  # No self sign-up. An operator creates every user with admin-create-user; a stranger who finds the
  # hosted UI gets a sign-in form and no way to make themselves an account. This is the whole reason
  # the sample can ship a real login without shipping an open registration endpoint.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # Email is the sign-in name, so an operator creates a user by address and the token carries an
  # `email` claim the console shows in the shell. auto_verified_attributes means the address the
  # operator typed is treated as verified, which is what makes the forgot-password flow reachable.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # 12 characters and all four character classes. Deliberately stricter than Cognito's default (8,
  # no symbol requirement): these are named human operators of a console that can change an agent's
  # instructions and approve ledger writes. temporary_password_validity_days is short because the
  # invite email carries the temporary password in clear text.
  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 3
  }

  # TOTP MFA, offered rather than forced by default (var.mfa_configuration). "ON" makes it mandatory
  # for every user, which is the right answer for a deployment handling real trades and the wrong one
  # for a first apply, because the operator has to complete an authenticator enrolment before they
  # can see anything. SMS is deliberately not offered: it needs an SNS role and a spend limit, and
  # AWS does not recommend it as a second factor.
  mfa_configuration = var.mfa_configuration

  software_token_mfa_configuration {
    enabled = var.mfa_configuration != "OFF"
  }

  # Cognito's own email sender, which is capped at 50 messages a day per account and sends from a
  # no-reply amazonaws.com address. That is enough for admin-created operator accounts and their
  # password resets, and nothing else in this sample sends mail through the pool. A deployment that
  # onboards more than a handful of people wires SES here (email_sending_account = "DEVELOPER").
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  # INACTIVE by default so `terraform destroy` can tear the sample down again — a pool with
  # protection ACTIVE refuses to be deleted until someone turns it off by hand, which for a sample a
  # customer is trying out is a trap rather than a safeguard. Set it ACTIVE for any deployment whose
  # user list you would mind losing: recreating the pool changes the issuer and every `sub`, so the
  # audit trail's author ids stop resolving.
  deletion_protection = var.deletion_protection

  tags = var.tags
}

# The hosted UI (managed login) host: <prefix>.auth.<region>.amazoncognito.com. The prefix is
# GLOBALLY unique across all AWS accounts, which is why it has no default — a name derived from
# name_prefix would collide with the next person to deploy this sample with the same prefix, and the
# failure arrives well into the apply as an InvalidParameterException.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.hosted_ui_prefix
  user_pool_id = aws_cognito_user_pool.this.id

  # 1 = the classic hosted UI. 2 = managed login, which is the newer branded experience and expects
  # an aws_cognito_managed_login_branding resource to go with it; without one it serves an unstyled
  # page. Left at 1 so the sample needs no branding resource, and exposed as a variable because
  # picking 2 is a one-line decision for a deployment that wants its own logo on the sign-in page.
  managed_login_version = var.managed_login_version
}

# The SPA app client. PUBLIC: no client secret, because the code runs in a browser where a secret
# would be readable by anyone who opens the network tab. Authorization code + PKCE is what replaces
# it — the browser proves it started the flow by presenting the verifier for the challenge it sent.
resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name_prefix}-console"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true

  # Only the pool itself. A federated SAML/OIDC provider added later must be NAMED here as well, or
  # the hosted UI will not offer it — adding the aws_cognito_identity_provider alone is not enough.
  supported_identity_providers = var.supported_identity_providers

  # Refresh only. There is deliberately no ALLOW_USER_SRP_AUTH or ALLOW_USER_PASSWORD_AUTH: the
  # console never sees a password, because the only place one is ever typed is the hosted UI on
  # Cognito's own domain. Dropping SRP means an XSS in the console cannot be turned into a
  # credential-stuffing endpoint against the pool. ALLOW_REFRESH_TOKEN_AUTH is required for the
  # silent renewal cognito-pkce.ts performs.
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  # An hour of access/id token, one day of refresh. The browser holds these, so the refresh window is
  # the real exposure: a day means a stolen refresh token is useful for at most a day, and a console
  # operator signs in once a working day.
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # A wrong password and a non-existent user must be indistinguishable, or the sign-in form becomes a
  # way to enumerate who works here.
  prevent_user_existence_errors = "ENABLED"

  # Makes sign-out actually end the session: without it a revoked refresh token keeps working until
  # it expires, so "sign out" on a shared machine would be cosmetic.
  enable_token_revocation = true

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # ⚠️ THIS IS A FIX, NOT A NOTE, AND IT IS ONLY LEGITIMATE BECAUSE OF THE PATCH IT REFERS TO.
  #
  # Cognito matches a callback URL EXACTLY, so the real one has to name the console's public host —
  # and that host is the CloudFront domain, which does not exist until the frontend tier has been
  # created. The frontend tier in turn needs this client's id as a build argument, so this module
  # cannot depend on it: referencing module.frontend from here would close a cycle Terraform refuses
  # outright. So the client is created with the URLs it can know (localhost, plus anything the
  # operator pinned) and the CloudFront URLs are added afterwards, in the same apply, by
  # aws_lambda_invocation.cognito_callbacks in infra/environments/recon/main.tf.
  #
  # That patch is invisible to this resource's state. Without the ignore below, every subsequent plan
  # would propose reverting the client to the create-time list — and applying it would break login
  # with a redirect_mismatch that points at nothing in the diff.
  #
  # The consequence to know: after the first apply, callback_urls and logout_urls are OWNED BY THE
  # PATCH. Changing var.callback_urls alone does nothing to a live client. The root therefore feeds
  # the same composed list to this resource and to the patch input, so the variable keeps working on
  # every apply. If you ever delete the patch, delete this lifecycle block in the same change.
  lifecycle {
    ignore_changes = [callback_urls, logout_urls]
  }
}

# The five groups the console resolves per request out of the token's group claim
# (chatbot-app/frontend/src/lib/auth/apps.ts and src/lib/console/): per-app ACCESS ("may use this
# app") and ADMIN ("may change its configuration and approve") for each of the two apps, plus the
# console-wide admin group that may edit the settings layer above both.
#
# These exist as REAL groups here, which is the substantive difference from an Okta or Entra
# deployment: with an external IdP nothing in this repo can create the group, so the operator
# maintains membership in a tenant Terraform cannot see. With this pool, the groups arrive with the
# stack and an operator's only remaining job is adding people to them.
#
# Created EMPTY, and that is the safe direction: an admin group with no members means nobody
# administers anything, which is the same fail-closed reading a blank group name has always had in
# this console.
locals {
  groups = {
    "recon-access" = {
      name        = var.recon_access_group
      description = "May use the Trade Reconciliation app (/recon and /api/recon/*)."
    }
    "recon-admin" = {
      name        = var.recon_admin_group
      description = "May change reconciliation configuration: the auto-resolve threshold, the agent backend, the Tier-1 switch, prompts, skills and the email allowlist."
    }
    "pipeline-access" = {
      name        = var.pipeline_access_group
      description = "May use the Deal Pipeline app (/pipeline and /api/pipeline/*)."
    }
    "pipeline-admin" = {
      name        = var.pipeline_admin_group
      description = "May approve deals, edit the parser prompt and skills, decide skill proposals, manage memory and change the pipeline's model."
    }
    "console-admin" = {
      name        = var.console_admin_group
      description = "May edit console-wide settings: which group reaches which app, app enablement and the shared defaults."
    }
  }
}

resource "aws_cognito_user_group" "console" {
  for_each = local.groups

  user_pool_id = aws_cognito_user_pool.this.id
  name         = each.value.name
  description  = each.value.description
}
