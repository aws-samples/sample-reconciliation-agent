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

variable "user_pool_arn" {
  description = <<-EOT
    ARN of the ONE Cognito user pool whose console app client this actor may patch, for the
    `patch_cognito_callbacks` action. The pool's callback and sign-out URLs have to name the console's
    public host, and that host (the CloudFront domain) does not exist when the client is created --
    the client's id is a build argument of the very tier that creates it, so the client cannot depend
    on it. The patch closes that loop inside one apply; see the lifecycle block on
    aws_cognito_user_pool_client.spa in modules/console-auth.

    Empty (the default) renders NO Cognito statement at all, which is what an Okta or Entra
    deployment must get: no identity provider of ours exists there, and a grant on
    `cognito-idp:*` scoped to nothing would be either useless or wide. Non-blank appends exactly one
    statement, LAST, scoped to this pool ARN alone.

    Two actions, not one. UpdateUserPoolClient REPLACES a client's whole configuration rather than
    merging into it, so a patch that sent only the URLs would silently strip the auth flows, scopes,
    token validity and supported providers off a working client. The action therefore reads the live
    client with DescribeUserPoolClient first and writes it back with the URLs changed and everything
    else as found -- which also means the client's configuration lives in ONE place (the console-auth
    module) instead of being duplicated into this invocation's input where it would drift.
  EOT
  type        = string
  default     = ""

  validation {
    # A pool id ("us-east-1_ABC123") or a bare name here would render a policy that applies cleanly
    # and authorizes nothing, and the symptom is an AccessDenied deep inside an apply.
    condition     = var.user_pool_arn == "" || can(regex("^arn:aws[a-z-]*:cognito-idp:[a-z0-9-]+:[0-9]{12}:userpool/[A-Za-z0-9_-]+$", var.user_pool_arn))
    error_message = "user_pool_arn must be blank or a full Cognito user pool ARN (arn:aws:cognito-idp:<region>:<account>:userpool/<pool-id>), not a pool id or name."
  }
}

variable "log_retention_days" {
  description = "CloudWatch retention for the actor's log group."
  type        = number
  default     = 14
}
