variable "name_prefix" {
  type = string
}
variable "lambda_zip" {
  description = "Path to the shared backend Lambda deployment zip (from the lambda-package module)."
  type        = string
}
variable "lambda_source_hash" {
  description = "Base64 SHA-256 of the shared Lambda zip (from the lambda-package module)."
  type        = string
}
# The hook's ONLY write target. No items/cases/audit variables exist here on purpose: a document is
# evidence, not a reconciliation item, so there is nothing else for it to write to.
variable "notices_table" {
  description = "DynamoDB table name holding extracted counterparty notices (the actual side)."
  type        = string
}

variable "notices_table_arn" {
  description = "ARN of the notices table, for the hook's PutItem grant."
  type        = string
}

# Two buckets, not one: the section results and page images live in IDP's OUTPUT bucket, but for any
# document whose tracking record exceeds Step Functions' 256 KB output cap the record itself is written
# to IDP's WORKING bucket and the event carries only a pointer to it (see
# `IdpOutputReader.resolve_document`). Without the working-bucket grant every large document — which in
# recon-dev is all of them — fails ingest on an AccessDenied.
#
# Name patterns rather than exact names because IDP's stack names its buckets with a generated suffix
# and redeploys change it; the hook must not need a recon apply every time IDP is rebuilt. Still
# least-privilege: GetObject/ListBucket only, and only on IDP-prefixed buckets in this account.
variable "idp_source_buckets" {
  description = "IDP bucket name patterns the hook may read at ingest (output bucket for extracted values and page images, working bucket for compressed tracking records)."
  type        = list(string)
  # Two patterns PER IDP deployment, and the pairs are easy to break apart: when the `idp-unified-*`
  # deployment replaced `idp-*`, its OUTPUT bucket was added here and its WORKING bucket was not.
  # Because the working bucket holds the compressed tracking record for every recon-dev document,
  # that omission failed ingest for 100% of uploads — with an AccessDenied naming a bucket that
  # appears nowhere in this repo. Add both patterns together or neither.
  default = [
    "idp-outputbucket-*",
    "idp-workingbucket-*",
    "idp-unified-output-*",
    "idp-unified-working-*",
  ]
}

# The IDP workflow whose SUCCEEDED event carries a completed document. Recon owns the EventBridge
# rule that reads it (see main.tf) rather than relying on IDP's own
# `PostProcessingLambdaHookFunctionArn` parameter, which is a setting in a stack this repo does not
# deploy — and which was found empty while the hook sat unreachable for weeks.
#
# An ARN rather than a name because the rule matches on `detail.stateMachineArn`, and a variable
# rather than a literal because IDP's stack names its state machine with a generated suffix that
# changes on every rebuild. Empty disables the rule, for an environment with no IDP deployment.
variable "idp_state_machine_arn" {
  description = "ARN of the IDP document-processing Step Functions state machine whose SUCCEEDED events trigger the hook. Empty to create no rule."
  type        = string
  default     = ""
}

variable "assets_bucket" {
  description = "Recon assets bucket page previews are copied into at ingest."
  type        = string
}

variable "assets_bucket_arn" {
  type = string
}

variable "vpc_subnet_ids" {
  description = "Private subnets to attach the Lambda(s) to ([] = no VPC)."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}
