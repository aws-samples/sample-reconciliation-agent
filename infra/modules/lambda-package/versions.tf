# Declared here, not only in the root, so `terraform init && terraform test` inside this module
# resolves the same provider major the root does instead of whatever is newest on the registry.
terraform {
  required_version = ">= 1.11.0"

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.0.0, < 3.0.0"
    }
  }
}
