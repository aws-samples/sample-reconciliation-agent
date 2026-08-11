# Remote state in S3 (versioned) so state is durable and never lives inside a git worktree.
# Bucket is created once out-of-band (see README): recon-dev-tfstate-<account_id>.
#
# PARTIAL CONFIGURATION: `bucket` is deliberately omitted here and supplied at init time from
# the gitignored backend.hcl (see backend.hcl.example). The bucket name embeds our AWS account
# ID because S3 bucket names are globally unique, and a backend block cannot use variables,
# locals, or interpolation of any kind — it is evaluated before the rest of the config, so
# terraform.tfvars cannot reach it. A separate -backend-config file is Terraform's supported
# mechanism for exactly this case, and it keeps the account ID out of every committed file.
#
#   terraform init -backend-config=backend.hcl
#
# Omitting the flag fails loudly: Terraform prompts for the missing bucket, or errors outright
# under -input=false, rather than silently initialising local state.
terraform {
  backend "s3" {
    key     = "recon/dev/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}
