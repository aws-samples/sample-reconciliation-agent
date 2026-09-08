variable "name_prefix" {
  description = "Resource name prefix, e.g. recon-dev."
  type        = string
}

variable "seed_extraction_config_version" {
  description = <<-EOT
    IDP configuration version name for the seeded extraction workflow type. Empty (the
    default) skips that seed entirely, which is the correct state for a deployment whose
    IDP configuration versions are not known yet -- an operator adds the type from the
    Config tab and types the version name there.

    There is no way to default this to something sensible. The names live in the IDP
    deployment and the API that lists them refuses a machine caller, so recon cannot
    discover them. A placeholder value would be worse than an absent one: an upload
    pinned to a version that does not exist is not rejected, it quietly gets whichever
    configuration is active instead.
  EOT
  type        = string
  default     = ""
}
