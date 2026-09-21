variable "name" {
  description = "Memory name. Must be an identifier (letters, digits, underscore): hyphens are rejected by the service, so callers pass replace(prefix, \"-\", \"_\") themselves."
  type        = string
}

variable "description" {
  description = "Memory description. null leaves the argument unset, which is what the recon memory has always had; a value here on an existing memory plans an in-place update."
  type        = string
  default     = null
}

variable "event_expiry_days" {
  description = "Days a raw event lives before the service expires it (event_expiry_duration, 7 to 365)."
  type        = number

  validation {
    condition     = var.event_expiry_days >= 7 && var.event_expiry_days <= 365 && floor(var.event_expiry_days) == var.event_expiry_days
    error_message = "event_expiry_days must be a whole number of days between 7 and 365."
  }
}

variable "region" {
  description = "Region of the inference profiles the execution role may invoke. Passed in rather than read from a data source so the rendered policy is exactly the caller's string (the recon module renders var.region, the pipeline data.aws_region)."
  type        = string
}

variable "account_id" {
  description = "Account whose inference profiles the execution role may invoke (see region)."
  type        = string
}

variable "create_execution_role" {
  description = <<-EOT
    Create the execution role and its Bedrock invoke policy here (true), or attach one made by
    another instance of this module (false, with execution_role_arn). A bool rather than
    "execution_role_arn == null" because the shared ARN is unknown at plan time on a fresh create
    and count cannot be decided from an unknown value.
  EOT
  type        = bool
  default     = true
}

variable "execution_role_name" {
  description = "Name of the execution role when create_execution_role is true; its inline policy is named \"<role>-policy\", the convention both existing memories already follow."
  type        = string
  default     = null

  validation {
    condition     = !var.create_execution_role || (var.execution_role_name != null && trimspace(var.execution_role_name) != "")
    error_message = "execution_role_name is required when create_execution_role is true."
  }
}

variable "execution_role_arn" {
  description = "ARN of an existing execution role to attach when create_execution_role is false (the pipeline's chat memory reuses the knowledge memory's role)."
  type        = string
  default     = null

  validation {
    condition     = var.create_execution_role || var.execution_role_arn != null
    error_message = "execution_role_arn is required when create_execution_role is false."
  }
}

variable "strategy" {
  description = <<-EOT
    Optional extraction strategy, CUSTOM type with a SEMANTIC_OVERRIDE configuration that overrides
    EXTRACTION only (main.tf explains why consolidation is left alone). null creates no strategy:
    an events-only memory, which is what the pipeline's chat transcript memory is.
      name              strategy name (create-only on the resource; renaming replaces it)
      namespaces        namespace templates the records are written under, e.g. ["app/kind/{actorId}"]
      description       optional, shown in the console
      model_id          Bedrock model or inference-profile id the extraction pass invokes
      extraction_prompt the COMPLETE extraction instructions (see the append_to_prompt note in main.tf)
  EOT
  type = object({
    name              = string
    namespaces        = list(string)
    description       = optional(string)
    model_id          = string
    extraction_prompt = string
  })
  default = null
}

variable "tags" {
  description = "Tags for the memory and the execution role. null leaves both untagged, as every existing memory is; an empty map is not the same thing to the provider, so pass null when there is nothing to tag."
  type        = map(string)
  default     = null
}
