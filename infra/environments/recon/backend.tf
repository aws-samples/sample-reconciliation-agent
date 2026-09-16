# Remote state in S3 (versioned) so state is durable and never lives inside a git worktree.
# The bucket — `recon-dev-tfstate-<account_id>` — is created once per account by infra/bootstrap.
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

    # STATE LOCKING. Without this, two applies running at once both read the same state, both
    # write it, and the second silently discards whatever the first created — leaving resources
    # alive in the account that no state file knows about.
    #
    # Two applies at once is an ordinary situation here: the pipeline applies automatically on the
    # default branch. Its apply job carries `resource_group: recon-dev-terraform`, but a
    # resource_group only serialises *pipeline jobs against each other* — it knows nothing about
    # someone running ./infra/scripts/deploy-recon.sh from a laptop at the same moment.
    #
    # `use_lockfile` is Terraform's S3-native lock (a .tflock object beside the state), so it
    # needs no DynamoDB table and no extra IAM beyond the s3:PutObject/DeleteObject the deploy
    # role already holds on this prefix. Requires Terraform >= 1.10; providers.tf pins >= 1.11.0.
    use_lockfile = true
  }
}
