variable "name_prefix" {
  description = "Resource name prefix (e.g. recon-dev)."
  type        = string
}

variable "assets_bucket_arn" {
  description = <<-EOT
    ARN of the assets bucket holding the UI-editable seed objects (prompts and skills) and their
    `.seed-marker/` fingerprints. Needs GetBucketEncryption on the bucket itself: the reconciliation
    compares an object's ETag against a content MD5, which is only valid under SSE-S3, and it refuses
    to run rather than compare fingerprints that do not mean what they are assumed to mean.
  EOT
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch retention for the actor's log group."
  type        = number
  default     = 14
}
