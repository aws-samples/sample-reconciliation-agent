# Declared here, not only in the roots, so `terraform init && terraform test` inside this module
# resolves the same provider major the roots do instead of whatever is newest on the registry. The
# floor is the roots' (infra/environments/recon/providers.tf explains it); nothing here needs a newer
# aws_cognito_* than that — managed_login_version on aws_cognito_user_pool_domain is the newest
# argument used and it predates the floor.
terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62.0, < 7.0.0"
    }
  }
}
