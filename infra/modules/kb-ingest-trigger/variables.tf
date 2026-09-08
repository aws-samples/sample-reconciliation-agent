variable "name_prefix" {
  description = "Prefix for every resource name, e.g. recon-dev."
  type        = string
}

variable "assets_bucket" {
  description = "The bucket holding the knowledge-base prefix. Uploads land under knowledge-base/uploads/."
  type        = string
}

variable "assets_bucket_arn" {
  description = "ARN of the assets bucket, for the notification's source-account condition."
  type        = string
}

variable "kb_id" {
  description = "The managed knowledge base to ingest into."
  type        = string
}

variable "kb_data_source_id" {
  description = "The knowledge base's S3 data source. Its inclusionPrefixes already covers knowledge-base/, so an uploads/ sub-prefix needs no change here."
  type        = string
}

variable "uploads_table_name" {
  description = "The recon-idp-uploads table, whose rows this Lambda moves out of PENDING_INGESTION."
  type        = string
}

variable "uploads_table_arn" {
  description = "ARN of the uploads table."
  type        = string
}

variable "uploads_table_index_arn" {
  description = "ARN of the table's by_recency index. A Query on an index needs the index ARN granted separately; the table ARN alone answers AccessDenied."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the shared backend deployment package."
  type        = string
}

variable "lambda_source_hash" {
  description = "The package's source hash, so a code change redeploys the function."
  type        = string
}

variable "vpc_subnet_ids" {
  description = "Subnets to attach the Lambda to. Empty means no VPC attachment."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security groups for the VPC attachment."
  type        = list(string)
  default     = []
}
