terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 6.62.0 is a FLOOR, not a preference. Two features exist only from that release, and
      # both replace a shim that shells out to the AWS CLI — which is unrunnable on a build image
      # whose bundled botocore is older than the API member being sent:
      #   - target_configuration { http { agentcore_runtime } } on aws_bedrockagentcore_gateway_target
      #     (the ingress target; see modules/recon-agent/main.tf)
      #   - credential_provider_configuration { oauth { grant_type, custom_parameters } } on the same
      #     resource (the Graph TOKEN_EXCHANGE and IDP CLIENT_CREDENTIALS targets)
      # Lowering this floor does not degrade gracefully — it fails at plan with an unsupported
      # argument.
      #
      # >= 6.55 was the previous floor: interceptor_configuration on aws_bedrockagentcore_gateway
      # (REQUEST interceptor = the gateway-layer provenance/transition guard). Still required, now
      # subsumed.
      #
      # ⚠️ HISTORY, still worth knowing: 6.57.0 corrupts outbound request bodies under Terraform's
      # default parallel refresh. A single `plan` produced a salad of errors across ~8 services, all
      # with genuine AWS request IDs — InvalidSignatureException (ECR/ECS/Logs/Glue),
      # SerializationException: UnknownError (DynamoDB/SSM/Cognito/Athena),
      # InvalidHttpRequest: Unable to parse request (EC2), NoSuchVersion, and IAM 302s. Not a
      # credential problem: the AWS CLI worked throughout, and the SAME 6.57.0 run with
      # -parallelism=1 produced zero AWS errors. The floor below now excludes it outright, so the
      # explicit `!= 6.57.0` is gone — but if this constraint is ever relaxed, put it back.
      # 6.62.0 was validated at DEFAULT parallelism against this stack on 2026-09-02: plan clean,
      # no request corruption, and no schema-induced drift on any AgentCore resource.
      version = ">= 6.62.0, < 7.0.0"
    }
    # ⚠️ hashicorp/external is deliberately NOT here any more, and it should not come back.
    #
    # It existed for three `data "external"` blocks that shelled out to read back values the API
    # already exposes: the Harness ARN + runtime id (python3 + boto3) and the two OAuth2 credential
    # provider ARNs and callback URL (aws + jq). All three are now CloudFormation stack Outputs
    # sourced from readOnly properties. Every one of them ran at PLAN time, which is what made a
    # plan — not just an apply — depend on an interpreter and a CLI being installed.
    #
    # A new `data "external"` reintroduces exactly that coupling. If a value seems to need one,
    # check the resource type's readOnlyProperties for a GetAtt first.

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
