output "key" {
  description = "The object's key, echoed so callers can name the seed in an invocation or a grant without repeating it."
  value       = local.object.key
}

output "bucket" {
  description = "The bucket the object was written to."
  value       = local.object.bucket
}

output "etag" {
  description = "The object's ETag as planned: the repo file's MD5 for a tracking seed; for a create-only seed, the MD5 at first write, whatever the repo says now."
  value       = local.object.etag
}

output "content_type" {
  description = "The object's Content-Type as planned (create-only seeds keep whatever the application last wrote)."
  value       = local.object.content_type
}

output "source_path" {
  description = "The repo file the object is seeded from (null for inline content), so a caller's test can compare etag to filemd5 of it."
  value       = var.source_path
}

output "create_only" {
  description = "Which behaviour this seed has, echoed so a caller's test can assert the split between create-only and tracking seeds."
  value       = var.create_only
}
