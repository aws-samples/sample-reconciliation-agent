output "zip_path" {
  description = "Path to the built Lambda deployment zip (root contains the backend/ package)."
  value       = data.archive_file.lambda.output_path
}

output "source_code_hash" {
  description = "Base64 SHA-256 of the zip, for aws_lambda_function.source_code_hash."
  value       = data.archive_file.lambda.output_base64sha256
}
