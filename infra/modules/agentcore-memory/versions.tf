# Declared here, not only in the root, so `terraform init && terraform test` inside this module
# resolves the same provider major the root does instead of whatever is newest on the registry.
# The floor is the one modules/deal-pipeline already states: aws_bedrockagentcore_memory and
# aws_bedrockagentcore_memory_strategy with SEMANTIC_OVERRIDE extraction need it.
terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62.0, < 7.0.0"
    }
  }
}
