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

variable "additional_assets_bucket_arns" {
  description = <<-EOT
    ARNs of further SSE-S3 buckets whose UI-editable seeds the same reconciliation pushes -- the
    deal pipeline's assets bucket when that app is deployed. Each gets the same two statements as
    assets_bucket_arn (GetEncryptionConfiguration on the bucket; Get/PutObject under it), APPENDED
    after the existing statements so that with the default [] the rendered policy is byte for byte
    what it was before this input existed, and the recon deployment plans no change. A list so the
    root can pass try([module.deal_pipeline[0].assets_bucket_arn], []).
  EOT
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch retention for the actor's log group."
  type        = number
  default     = 14
}
