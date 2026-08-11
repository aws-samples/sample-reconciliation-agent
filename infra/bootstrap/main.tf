# Terraform-state bucket bootstrap for this project.
#
# Chicken-and-egg config: it creates the S3 bucket that every environment stores its state IN, so
# it cannot use that bucket as its own backend. It keeps LOCAL state (there is deliberately no
# `backend` block) and is run at most once per account.
#
# IMPORTANT — the live bucket predates this config. `recon-dev-tfstate-<account_id>` was created
# out-of-band before it was expressed as code, so a plain `terraform apply` here will fail with
# BucketAlreadyOwnedByYou rather than adopt it. Import first:
#
#   cd infra/bootstrap && terraform init
#   BUCKET="recon-dev-tfstate-$(aws sts get-caller-identity --profile huthmac \
#     --query Account --output text)"
#   terraform import aws_s3_bucket.tfstate                                  "$BUCKET"
#   terraform import aws_s3_bucket_versioning.tfstate                       "$BUCKET"
#   terraform import aws_s3_bucket_server_side_encryption_configuration.tfstate "$BUCKET"
#   terraform import aws_s3_bucket_public_access_block.tfstate              "$BUCKET"
#   terraform plan   # expect "No changes" — the live bucket already has all four settings
#
# Until that import happens the bucket has no Terraform source, which is why drift in its
# encryption / versioning / public-access settings would not appear in any `terraform plan` — a
# caveat recorded under F1 in the security-audit report (kept outside this repository).
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.32"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
      Purpose   = "tf-state-bootstrap"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "recon-dev"
}

data "aws_caller_identity" "current" {}

locals {
  # No region suffix — this matches the live bucket. S3 bucket names are globally unique, hence the
  # account ID, which is read from the caller identity rather than committed anywhere.
  state_bucket = "${var.project_name}-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket
  # State history is the last line of defence against a bad apply — never let Terraform empty it.
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

output "backend_hcl" {
  # The environment's backend.tf already pins key/region/encrypt; the bucket name is the only
  # setting that has to be supplied at init time (see environments/recon/backend.hcl.example).
  description = "Paste into environments/recon/backend.hcl"
  value       = <<-EOT
    bucket = "${aws_s3_bucket.tfstate.bucket}"
  EOT
}
