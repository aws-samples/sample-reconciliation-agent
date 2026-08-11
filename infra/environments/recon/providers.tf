terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 6.55: interceptor_configuration on aws_bedrockagentcore_gateway (REQUEST
      # interceptor = the gateway-layer provenance/transition guard).
      #
      # != 6.57.0: that release corrupts outbound request bodies under Terraform's default
      # parallel refresh. A single `plan` produced a salad of errors across ~8 services, all
      # with genuine AWS request IDs — InvalidSignatureException (ECR/ECS/Logs/Glue),
      # SerializationException: UnknownError (DynamoDB/SSM/Cognito/Athena),
      # InvalidHttpRequest: Unable to parse request (EC2), NoSuchVersion, and IAM 302s.
      # Not a credential problem: the AWS CLI worked throughout, and the SAME 6.57.0 run
      # with -parallelism=1 produced zero AWS errors. 6.56.0 at default parallelism is clean.
      # Until now only the (gitignored) .terraform.lock.hcl kept us off 6.57.0, so any fresh
      # worktree or CI checkout resolved straight into the broken version.
      version = "~> 6.55, != 6.57.0"
    }
    # AgentCore Harness ARN read-back (manage_harness.py --lookup) — see recon-agent-harness.
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
    # Email human-confirmation token (random_password.email_confirmation).
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

provider "aws" {
  region = var.region
}
