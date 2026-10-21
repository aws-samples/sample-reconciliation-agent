# Declared here, not only in the root, so `terraform init && terraform test` inside this module
# resolves the same provider majors the root does instead of whatever is newest on the registry.
# The aws floor is the root's (infra/environments/recon/providers.tf explains it); null is for the
# two local-exec drivers (source upload, CodeBuild trigger).
terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62.0, < 7.0.0"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.0.0, < 4.0.0"
    }
  }
}
