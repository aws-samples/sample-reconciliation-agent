####################################################################################
# seeded-object: one S3 object seeded from the repo, either CREATE-ONLY or TRACKING the repo.
#
# The whole module exists for one line. A create-only seed must ignore
#
#   [etag, source, content, content_type, metadata, cache_control, content_encoding, storage_class]
#
# and not merely [etag, source]: the AWS provider treats a diff in ANY of these attributes as a
# content change and resolves it by re-uploading the whole object from `source` -- the repo file --
# not with a metadata-only update. Ignoring only etag/source lets an application write that merely
# sets a charset or an x-amz-meta-* tag make the next apply silently revert an analyst's edit to the
# committed version. `ignore_changes` must be a literal list, so it cannot come from a variable and
# the only way to spell the list once is a wrapper module; the two roots and the pipeline module call
# this instead of repeating (and, as recon's seeds did, narrowing) it.
#
# A lifecycle block cannot be conditional either, so the two behaviours are two resource blocks with
# count, exactly one of which is instantiated. Everything else about the two is identical.
#
# `etag = filemd5(...)` is what lets a TRACKING seed notice a changed file at plan time. It is only
# meaningful under SSE-S3, where an object's ETag is still its MD5; under SSE-KMS the ETag is opaque
# and every plan would want to re-upload every seed. The buckets this is used with are SSE-S3 for
# that reason (and because the deploy-actions seed_push reconciliation depends on the same property).
####################################################################################

locals {
  # The same fingerprint either way in; for `content` the digest is of the string as it will be
  # stored, matching what S3 reports for a single-part SSE-S3 object.
  etag = var.source_path != null ? filemd5(var.source_path) : md5(var.content)

  # The one instance that exists, for the outputs. one() rather than [0] so the un-instantiated
  # block is never indexed.
  object = var.create_only ? one(aws_s3_object.create_only) : one(aws_s3_object.tracking)
}

# CREATE-ONLY. First write only; the application owns every later byte.
resource "aws_s3_object" "create_only" {
  count = var.create_only ? 1 : 0

  bucket       = var.bucket
  key          = var.key
  source       = var.source_path
  content      = var.content
  etag         = local.etag
  content_type = var.content_type

  lifecycle {
    # The literal list this module exists to spell once -- see the header. `content` is included
    # for the inline-content form of this module: it is unset (null in config and in state) on every
    # file-sourced seed, where ignoring it is a no-op.
    ignore_changes = [etag, source, content, content_type, metadata, cache_control, content_encoding, storage_class]
  }
}

# TRACKING. A committed change to the file re-uploads on the next apply.
resource "aws_s3_object" "tracking" {
  count = var.create_only ? 0 : 1

  bucket       = var.bucket
  key          = var.key
  source       = var.source_path
  content      = var.content
  etag         = local.etag
  content_type = var.content_type
}
