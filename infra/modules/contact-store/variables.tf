variable "name_prefix" {
  description = "Resource name prefix, e.g. recon-dev."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared backend deployment zip."
  type        = string
}

variable "lambda_source_hash" {
  description = "base64sha256 of the backend zip, so Terraform redeploys on code change."
  type        = string
}

variable "vpc_subnet_ids" {
  description = "Private subnet ids for the query Lambda. Empty list = no VPC attachment."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security group ids for the query Lambda. Empty list = no VPC attachment."
  type        = list(string)
  default     = []
}

variable "notify_email" {
  description = <<-EOT
    Seed address for the internal-notification contact, used ONCE at create time.
    This is no longer the address anything sends to -- nothing reads this variable at
    runtime. It only fills in the first row of the contacts table so a fresh deploy has a
    working notification recipient; after that the row is the operator's to edit from the
    Config tab, and the seed carries ignore_changes so later applies leave those edits
    alone. Changing this value on an existing deployment therefore does nothing. Empty
    skips the seed entirely, which is a valid state: notifications simply do not send
    until an operator adds a contact.
  EOT
  type        = string
  default     = ""
}
