variable "name_prefix" {
  description = "Prefix applied to the pool and app client names (e.g. recon-dev)."
  type        = string
}

# Globally unique across every AWS account, so there is deliberately NO default: a prefix derived
# from name_prefix would collide with the next person who deploys this sample, and the collision
# surfaces mid-apply as an InvalidParameterException rather than at plan. The reserved-word rule is
# Cognito's own and it is easy to trip: "recon-cognito-dev" is refused, "recon-login-dev" is not.
variable "hosted_ui_prefix" {
  description = "Globally unique hosted-UI (managed login) domain prefix; the sign-in host becomes <prefix>.auth.<region>.amazoncognito.com. Lowercase letters, digits and hyphens, and it may not contain \"aws\", \"amazon\" or \"cognito\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.hosted_ui_prefix))
    error_message = "hosted_ui_prefix must be 1-63 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit."
  }

  validation {
    # Cognito refuses these substrings outright. Checked separately from the character rule so the
    # message names the actual problem instead of a regex.
    condition = !anytrue([
      for word in ["aws", "amazon", "cognito"] : strcontains(var.hosted_ui_prefix, word)
    ])
    error_message = "hosted_ui_prefix may not contain \"aws\", \"amazon\" or \"cognito\" — Cognito reserves those substrings and rejects the domain at apply."
  }
}

# ---------------------------------------------------------------------------------
# OAuth callback and sign-out URLs.
#
# ⚠️ Read the lifecycle block on aws_cognito_user_pool_client.spa before changing these. They are
# applied when the client is CREATED and then owned by the out-of-band patch that adds the CloudFront
# URLs, so editing them alone does not move a live client. The root passes the same composed list
# here and into that patch, which is what keeps them effective on every apply.
# ---------------------------------------------------------------------------------

variable "callback_urls" {
  description = "Allowed OAuth redirect URLs for the SPA client. Cognito matches EXACTLY, so each entry must be the full URL the browser sends, path included (the console serves the redirect on /callback — chatbot-app/frontend/src/lib/auth/cognito-pkce.ts, COGNITO_CALLBACK_PATH). http:// is accepted by Cognito only for localhost."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "callback_urls must name at least one URL: a client with none can never complete a sign-in, and the hosted UI answers redirect_mismatch with nothing in the plan to explain it."
  }

  validation {
    condition = alltrue([
      for url in var.callback_urls :
      can(regex("^https://", url)) || can(regex("^http://localhost(:[0-9]+)?(/|$)", url))
    ])
    error_message = "each callback_urls entry must be an https:// URL, or an http://localhost URL — Cognito refuses plain http for any other host."
  }
}

variable "logout_urls" {
  description = "Allowed sign-out redirect URLs. The console signs out to its own ORIGIN with no trailing slash, because cognito-pkce.ts sends window.location.origin as logout_uri and Cognito compares the string exactly; a registered \"https://host/\" does not match \"https://host\"."
  type        = list(string)

  validation {
    condition = alltrue([
      for url in var.logout_urls :
      can(regex("^https://", url)) || can(regex("^http://localhost(:[0-9]+)?(/|$)", url))
    ])
    error_message = "each logout_urls entry must be an https:// URL, or an http://localhost URL — Cognito refuses plain http for any other host."
  }
}

# ---------------------------------------------------------------------------------
# The five console groups, one variable each so a deployment can rename any of them and so a blank
# one fails the plan by NAME rather than creating a group called "".
#
# The defaults are generic role names, not anyone's real directory groups, and they are what makes a
# first apply coherent: the pool creates these five and the root hands the same five strings to the
# console, so the group the token carries is the group the proxy checks.
#
# The pattern is NARROWER than the console's own (chatbot-app/frontend/src/lib/console/types.ts
# allows spaces) and that is not an oversight: Cognito's GroupName does not permit whitespace, so a
# console group named "Recon Analysts" cannot exist as a group in this pool. Refused here at plan
# instead of at apply, where the message names a field rather than a variable.
# ---------------------------------------------------------------------------------

variable "recon_access_group" {
  description = "Name of the group whose members may use the Trade Reconciliation app."
  type        = string
  default     = "recon-users"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.:@/-]{1,128}$", var.recon_access_group))
    error_message = "recon_access_group must be 1-128 characters of letters, digits, '_', '.', ':', '@', '/' or '-' and may not be blank or contain whitespace: Cognito's GroupName rejects spaces, and a blank name would create a group called \"\" that no token could ever carry."
  }
}

variable "recon_admin_group" {
  description = "Name of the group whose members may change reconciliation configuration."
  type        = string
  default     = "recon-admins"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.:@/-]{1,128}$", var.recon_admin_group))
    error_message = "recon_admin_group must be 1-128 characters of letters, digits, '_', '.', ':', '@', '/' or '-' and may not be blank or contain whitespace: Cognito's GroupName rejects spaces, and a blank name would create a group called \"\" that no token could ever carry."
  }
}

variable "pipeline_access_group" {
  description = "Name of the group whose members may use the Deal Pipeline app."
  type        = string
  default     = "deal-desk"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.:@/-]{1,128}$", var.pipeline_access_group))
    error_message = "pipeline_access_group must be 1-128 characters of letters, digits, '_', '.', ':', '@', '/' or '-' and may not be blank or contain whitespace: Cognito's GroupName rejects spaces, and a blank name would create a group called \"\" that no token could ever carry."
  }
}

variable "pipeline_admin_group" {
  description = "Name of the group whose members may approve deals and change pipeline configuration."
  type        = string
  default     = "deal-desk-admins"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.:@/-]{1,128}$", var.pipeline_admin_group))
    error_message = "pipeline_admin_group must be 1-128 characters of letters, digits, '_', '.', ':', '@', '/' or '-' and may not be blank or contain whitespace: Cognito's GroupName rejects spaces, and a blank name would create a group called \"\" that no token could ever carry."
  }
}

variable "console_admin_group" {
  description = "Name of the group whose members may edit console-wide settings."
  type        = string
  default     = "console-admins"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.:@/-]{1,128}$", var.console_admin_group))
    error_message = "console_admin_group must be 1-128 characters of letters, digits, '_', '.', ':', '@', '/' or '-' and may not be blank or contain whitespace: Cognito's GroupName rejects spaces, and a blank name would create a group called \"\" that no token could ever carry."
  }
}

# ---------------------------------------------------------------------------------
# Posture knobs. Every one of these has a default that is safe to apply unattended; the comments say
# which way to move them for a deployment that is not a trial.
# ---------------------------------------------------------------------------------

variable "mfa_configuration" {
  description = "Pool MFA: \"OPTIONAL\" (default — TOTP offered, the user may skip it), \"ON\" (TOTP required for everyone; enrolment happens before the console is reachable) or \"OFF\". SMS is not offered in any mode."
  type        = string
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "OPTIONAL", "ON"], var.mfa_configuration)
    error_message = "mfa_configuration must be OFF, OPTIONAL or ON."
  }
}

variable "deletion_protection" {
  description = "\"INACTIVE\" (default) lets `terraform destroy` remove the pool, which is what a sample being trialled needs. \"ACTIVE\" refuses deletion until an operator turns it off by hand — set it for any deployment whose user list and `sub` values you would mind losing, because recreating the pool changes the issuer and every author id in the audit trail."
  type        = string
  default     = "INACTIVE"

  validation {
    condition     = contains(["ACTIVE", "INACTIVE"], var.deletion_protection)
    error_message = "deletion_protection must be ACTIVE or INACTIVE."
  }
}

variable "managed_login_version" {
  description = "1 (default) serves the classic hosted UI, which needs no extra resources. 2 serves managed login, the newer branded sign-in experience — pair it with an aws_cognito_managed_login_branding resource or it renders unstyled."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2], var.managed_login_version)
    error_message = "managed_login_version must be 1 (classic hosted UI) or 2 (managed login)."
  }
}

variable "supported_identity_providers" {
  description = "Identity providers the app client offers. [\"COGNITO\"] (the default) is the pool's own directory. When federating an enterprise IdP, create an aws_cognito_identity_provider on this pool and ADD its name here — the provider resource alone does not make the hosted UI offer it."
  type        = list(string)
  default     = ["COGNITO"]

  validation {
    condition     = length(var.supported_identity_providers) > 0
    error_message = "supported_identity_providers must name at least one provider; an empty list leaves the client with no way to authenticate anyone."
  }
}

variable "tags" {
  description = "Extra tags for the user pool (the provider's default_tags apply on top)."
  type        = map(string)
  default     = {}
}
