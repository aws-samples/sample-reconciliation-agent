output "zip_path" {
  description = "Path to the built Lambda deployment zip (root contains the backend/ package)."
  value       = data.archive_file.lambda.output_path
}

output "source_code_hash" {
  description = "Base64 SHA-256 of the zip, for aws_lambda_function.source_code_hash."
  value       = data.archive_file.lambda.output_base64sha256
}

# The three below are known at PLAN time (they depend only on the source tree and the inputs),
# unlike the zip outputs above, which is what makes them testable and what makes them useful for
# answering "why does this plan want to repackage?" without applying.
output "staged_files" {
  description = "Files under backend_dir that will be packaged, relative to backend_dir; exactly the set whose content feeds stage_hash."
  value       = local.staged_files
}

output "stage_hash" {
  description = "Value terraform_data.stage keys on (sources, dependency list, platform, Python version, name). Differs between two plans exactly when the zip would be rebuilt."
  value       = local.stage_hash
}

output "staging_dir" {
  description = "Directory this instance stages into and archive_file zips (.build/<name>/staging under the module). Per instance, so roots sharing one checkout cannot stage over each other; also the path to rebuild by hand when plan reports 'could not archive missing directory'."
  value       = local.staging_dir
}
