# The SSM path every console-wide setting lives under, e.g. "/recon-dev/console". The frontend reads
# the same string from CONSOLE_SETTINGS_PREFIX and appends the keys the contract fixes
# (chatbot-app/frontend/src/lib/console/types.ts), so the two must agree to the character.
#
# Validated as an absolute SSM hierarchy WITHOUT a trailing slash: the task role's grant is built
# as "parameter<prefix>" and "parameter<prefix>/*", and a trailing slash turns the second into
# "parameter<prefix>//*", which matches nothing, while a missing leading slash produces a parameter
# name SSM rejects. Either mistake would apply cleanly and fail at the first request.
variable "prefix" {
  description = "Absolute SSM path under which every console-wide parameter is created, without a trailing slash (e.g. \"/recon-dev/console\"). Must equal the console's CONSOLE_SETTINGS_PREFIX."
  type        = string

  validation {
    condition     = can(regex("^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$", var.prefix))
    error_message = "prefix must be an absolute SSM hierarchy such as \"/recon-dev/console\": a leading slash, segments of letters, digits, '_', '.' or '-', and no trailing slash."
  }
}

# ---------------------------------------------------------------------------------
# SEEDS. Each value below is written to its parameter ONCE, when the parameter is created, and never
# again: the console UI owns the value from then on (see main.tf). They are the same values the root
# hands the ECS task as environment variables, so on day one the stored layer and the environment
# agree and the UI's Settings screen shows every field as "stored"; an operator then edits in the UI
# without a redeploy.
#
# The validations mirror the limits the UI enforces on a PUT (GROUP_NAME_MAX, GROUP_NAME_PATTERN,
# ORGANIZATION_LABEL_MAX, MODEL_ID_PATTERN in types.ts). A seed the UI could not have written would
# render in the Settings screen as a value the operator cannot re-save, so it is refused at plan
# instead. Blank (after trimming) is always allowed and means "do not create this parameter".
# ---------------------------------------------------------------------------------

variable "recon_access_group" {
  description = "Seed for <prefix>/access/recon/access-group: IdP group that may use the reconciliation app. Blank creates no parameter."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.recon_access_group) == "" || (length(trimspace(var.recon_access_group)) <= 128 && can(regex("^[A-Za-z0-9 _.:@/-]+$", trimspace(var.recon_access_group))))
    error_message = "recon_access_group must be blank or a group name of at most 128 characters drawn from letters, digits, space, '_', '.', ':', '@', '/' and '-', the same rule the console's Settings screen applies."
  }
}

variable "recon_admin_group" {
  description = "Seed for <prefix>/access/recon/admin-group: IdP group that administers the reconciliation app. Blank creates no parameter."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.recon_admin_group) == "" || (length(trimspace(var.recon_admin_group)) <= 128 && can(regex("^[A-Za-z0-9 _.:@/-]+$", trimspace(var.recon_admin_group))))
    error_message = "recon_admin_group must be blank or a group name of at most 128 characters drawn from letters, digits, space, '_', '.', ':', '@', '/' and '-', the same rule the console's Settings screen applies."
  }
}

variable "pipeline_access_group" {
  description = "Seed for <prefix>/access/pipeline/access-group: IdP group that may use the deal-pipeline app. Blank creates no parameter."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.pipeline_access_group) == "" || (length(trimspace(var.pipeline_access_group)) <= 128 && can(regex("^[A-Za-z0-9 _.:@/-]+$", trimspace(var.pipeline_access_group))))
    error_message = "pipeline_access_group must be blank or a group name of at most 128 characters drawn from letters, digits, space, '_', '.', ':', '@', '/' and '-', the same rule the console's Settings screen applies."
  }
}

variable "pipeline_admin_group" {
  description = "Seed for <prefix>/access/pipeline/admin-group: IdP group that administers the deal-pipeline app. Blank creates no parameter."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.pipeline_admin_group) == "" || (length(trimspace(var.pipeline_admin_group)) <= 128 && can(regex("^[A-Za-z0-9 _.:@/-]+$", trimspace(var.pipeline_admin_group))))
    error_message = "pipeline_admin_group must be blank or a group name of at most 128 characters drawn from letters, digits, space, '_', '.', ':', '@', '/' and '-', the same rule the console's Settings screen applies."
  }
}

# A bool, rendered as the literal "true" or "false" the registry's isAppEnabled compares against
# (only the exact string "false" disables). No default on purpose: the root that composes the
# pipeline knows whether it did, and a wrong default here would seed a stored value that outranks
# the PIPELINE_ENABLED the same root sets on the task.
variable "pipeline_enabled" {
  description = "Seed for <prefix>/apps/pipeline/enabled: whether the deal-pipeline app is deployed on this console. Always creates the parameter (\"true\" or \"false\")."
  type        = bool
}

variable "default_model_id" {
  description = "Seed for <prefix>/defaults/model-id: Bedrock model or inference-profile id an app may inherit when its own parameter is blank. Blank creates no parameter."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.default_model_id) == "" || can(regex("^[A-Za-z0-9._:/-]+$", trimspace(var.default_model_id)))
    error_message = "default_model_id must be blank or a Bedrock model / inference-profile id made of letters, digits, '.', '_', ':', '/' and '-', the same rule the console's Settings screen applies."
  }
}

variable "organization_label" {
  description = "Seed for <prefix>/defaults/organization-label: the label shown under the console mark in the rail. Blank creates no parameter."
  type        = string
  default     = ""

  validation {
    condition     = length(trimspace(var.organization_label)) <= 60
    error_message = "organization_label must be at most 60 characters after trimming, the limit the console's rail can show."
  }
}
