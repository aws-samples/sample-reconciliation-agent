terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 6.62.0 is a FLOOR, not a preference. Three schema features this stack depends on are
      # unavailable below it, and lowering the floor does not degrade gracefully — it fails at plan
      # with an unsupported-argument error:
      #   - target_configuration { http { agentcore_runtime } } on aws_bedrockagentcore_gateway_target
      #     (the ingress target; see modules/recon-agent/main.tf)
      #   - credential_provider_configuration { oauth { grant_type, custom_parameters } } on the same
      #     resource (the Graph TOKEN_EXCHANGE and IDP CLIENT_CREDENTIALS targets)
      #   - interceptor_configuration on aws_bedrockagentcore_gateway (the REQUEST interceptor that
      #     enforces the gateway-layer provenance/transition guard)
      #
      # The upper bound excludes the next major, whose AgentCore schema is not validated here.
      version = ">= 6.62.0, < 7.0.0"
    }
    # ⚠️ hashicorp/external is deliberately absent, and must stay absent.
    #
    # A `data "external"` block runs at PLAN time, so it makes a plain `terraform plan` — not just
    # an apply — depend on an interpreter (python3, jq) and the AWS CLI being installed on whatever
    # machine or build image runs it. Values that look like they need a shell-out — the Harness ARN
    # and runtime id, the OAuth2 credential provider ARNs and callback URL — are all reachable as
    # CloudFormation stack Outputs backed by readOnly properties. Check the resource type's
    # readOnlyProperties for a GetAtt before reaching for an external data source.

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
