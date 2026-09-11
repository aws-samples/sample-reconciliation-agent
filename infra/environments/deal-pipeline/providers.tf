terraform {
  required_version = ">= 1.11.0"

  # LOCAL state, deliberately: there is no `backend` block. This root is a single-developer demo
  # that is applied and destroyed from one laptop; a remote S3 backend only pays off when CI
  # applies it. Nothing else shares this state, so nothing else needs to read it.

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Floor chosen because aws_bedrockagentcore_memory and
      # aws_bedrockagentcore_memory_strategy (with SEMANTIC_OVERRIDE extraction) are the resources
      # this root depends on were validated at this version; 6.57.0 is excluded for a
      # known request-corruption regression.
      version = ">= 6.62.0, < 7.0.0"
    }
  }
}

provider "aws" {
  region = var.region

  # Every resource carries these, which is what makes the demo removable as a unit: a tag search
  # on Project = deal-pipeline-demo lists everything this root created, including anything a
  # failed destroy left behind.
  default_tags {
    tags = {
      Project   = "deal-pipeline-demo"
      ManagedBy = "terraform"
    }
  }
}
