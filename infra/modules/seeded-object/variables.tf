variable "bucket" {
  description = "Bucket the object is written to (name or id)."
  type        = string
}

variable "key" {
  description = "Object key. Changing it replaces the object -- on a create-only seed that discards every edit the application made to the live object, so rename with a `moved` block or not at all."
  type        = string
}

variable "source_path" {
  description = "Path of the repo file whose bytes seed the object. Exactly one of source_path and content. (Not `source`: that name is a module meta-argument.)"
  type        = string
  default     = null

  validation {
    condition     = (var.source_path == null) != (var.content == null)
    error_message = "Exactly one of source_path and content must be set."
  }
}

variable "content" {
  description = "Inline content that seeds the object, for callers that render it rather than read a file. Exactly one of source_path and content."
  type        = string
  default     = null
}

variable "content_type" {
  description = "Content-Type stored on the object. Stated by every caller rather than defaulted, because a seed moved in here with a different value would plan a re-upload."
  type        = string
}

variable "create_only" {
  description = <<-EOT
    true: the object is written on first apply and never again by Terraform, because the application
    rewrites it in place (UI prompt editor, skills manager, approved skill proposals) and an apply
    must never revert those edits. Repo edits reach the live object through the deploy-actions
    seed_push reconciliation the roots run, not through this resource.
    false: the object TRACKS the repo file -- a committed change re-uploads on the next apply, which
    is the only way to ship a fix to content that has no UI editor (reference data, sample corpora,
    read-only source viewers).
  EOT
  type        = bool
}
