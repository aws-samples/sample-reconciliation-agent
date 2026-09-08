# Microsoft Graph via AgentCore Gateway, with OBO (On-Behalf-Of) token exchange available.
#
# ⚠️ SPLIT IMPLEMENTATION, and the split is not arbitrary.
#
# The GATEWAY TARGET is native: aws 6.62.0 models `mcp { open_api_schema { inline_payload } }` and
# `credential_provider_configuration { oauth { grant_type, custom_parameters, scopes } }`, which is
# everything the TOKEN_EXCHANGE + requested_token_use configuration needs.
#
# The CREDENTIAL PROVIDER is CloudFormation. `aws_bedrockagentcore_oauth2_credential_provider`
# models client_id/client_secret/oauth_discovery and nothing else — it has no
# `client_authentication_method` and no `on_behalf_of_token_exchange_config`, both of which this
# module requires (CLIENT_SECRET_POST, and JWT_AUTHORIZATION_GRANT in obo mode).
# AWS::BedrockAgentCore::OAuth2CredentialProvider models both.
#
# Both used to be null_resource provisioners shelling out to the AWS CLI, which meant an apply
# needed the CLI plus jq on whatever machine ran Terraform — and a `data "external"` read the
# provider ARN and callback URL back at PLAN time, so even a plan did.
#
# The client secret now lives in Secrets Manager and is referenced by the template
# (ClientSecretConfig + ClientSecretSource=EXTERNAL) rather than embedded in it. Inlining it would
# have put the plaintext into the CloudFormation template, readable by anyone holding
# cloudformation:GetTemplate — a far wider grant than the state bucket.
#
# ⚠️ EXTERNAL does need a grant on the secret, and reaching READY does NOT prove otherwise. Provider
# creation and target validation both succeed without one; the grant is only exercised later, when the
# gateway MINTS an outbound token, and it is the GATEWAY's role that reads the secret rather than this
# module's. Missing it fails every call with `Failed to fetch outbound oauth token. Access denied when
# retrieving the provided secret`. The grant therefore lives on the gateway role in
# `modules/recon-agent` (matched by secret NAME, because this module depends on that one for
# `gateway_id` and an ARN reference back would be a cycle).

locals {
  is_cc         = var.auth_mode == "client_credentials"
  provider_name = "microsoft-graph-obo-provider"
  target_name   = "microsoft-graph"
  # client_credentials mode exposes only app-only-compatible operations (no /me — there's no
  # signed-in user for an app-only token to resolve against).
  schema_path    = local.is_cc ? "${path.module}/openapi-schema-app.json" : "${path.module}/openapi-schema.json"
  openapi_schema = file(local.schema_path)
  # (No schema hash any more: it existed only to trigger the retired provisioner. The native target
  # diffs on the payload itself, so a schema edit is an ordinary in-place update.)
  # MSAL.js issues v2.0 tokens (issuer https://login.microsoftonline.com/{tenant}/v2.0).
  # The OBO discovery URL must point at the v2.0 metadata so AgentCore Identity
  # POSTs the swap to /oauth2/v2.0/token and validates JWKS for v2 tokens. Same endpoint
  # shape serves the client_credentials token request.
  discovery_url  = "https://login.microsoftonline.com/${var.tenant_id}/v2.0/.well-known/openid-configuration"
  oauth_scopes   = ["https://graph.microsoft.com/.default"]
  graph_audience = "https://graph.microsoft.com"
  # OBO: JWT_AUTHORIZATION_GRANT token-exchange config on the PROVIDER (Entra swaps the
  # inbound assertion for a Graph token). client_credentials: no such config — the provider
  # just holds app credentials; the GRANT TYPE (CLIENT_CREDENTIALS vs TOKEN_EXCHANGE) is
  # selected on the gateway TARGET's credential config instead (see gateway_target below).
  # PascalCase because this goes into a CloudFormation template, not a boto3 call.
  obo_config = local.is_cc ? {} : {
    OnBehalfOfTokenExchangeConfig = { GrantType = "JWT_AUTHORIZATION_GRANT" }
  }

  # The secret is referenced, never embedded — see the header. JsonKey selects the field inside the
  # Secrets Manager JSON document, so the secret can carry more than one value later without
  # changing this wiring.
  client_secret_json_key = "client_secret"

  oauth_provider_config = merge(
    {
      ClientId = var.client_id
      OauthDiscovery = {
        DiscoveryUrl = local.discovery_url
      }
      ClientAuthenticationMethod = "CLIENT_SECRET_POST"
      ClientSecretSource         = "EXTERNAL"
      ClientSecretConfig = {
        SecretId = var.enabled ? aws_secretsmanager_secret.client_secret[0].arn : ""
        JsonKey  = local.client_secret_json_key
      }
    },
    local.obo_config,
  )
}

# ============================================================
# OAuth2 Credential Provider — CustomOauth2 with OBO config
# ============================================================

# The Entra app client secret, referenced by the CloudFormation template rather than embedded in it.
#
# Terraform state holds this value either way (it is a `sensitive` variable used as a resource
# argument), but a template does NOT have to: cloudformation:GetTemplate is a much broader grant
# than read access to the state bucket, and templates are readable for the life of the stack.
resource "aws_secretsmanager_secret" "client_secret" {
  #checkov:skip=CKV_AWS_149:Encrypted at rest with the AWS-managed Secrets Manager key; a customer-managed CMK adds key-management overhead not warranted for a demo integration credential.
  #checkov:skip=CKV2_AWS_57:Rotation is not applicable — rotating this requires issuing a new secret in the Entra app registration, which is a manual tenant-side action.
  count = var.enabled ? 1 : 0
  name  = "${var.project_name}-graph-oauth"
}

resource "aws_secretsmanager_secret_version" "client_secret" {
  count     = var.enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.client_secret[0].id
  # A JSON document, not a bare string, because ClientSecretConfig addresses the value by JsonKey.
  secret_string = jsonencode({ (local.client_secret_json_key) = var.client_secret })
}

resource "aws_cloudformation_stack" "oauth_provider" {
  count = var.enabled ? 1 : 0
  name  = "${var.project_name}-graph-oauth-provider"

  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "Microsoft Graph OAuth2 credential provider (managed by Terraform; see infra/modules/microsoft-graph-obo)."

    Resources = {
      Provider = {
        Type = "AWS::BedrockAgentCore::OAuth2CredentialProvider"
        Properties = {
          Name                     = local.provider_name
          CredentialProviderVendor = "CustomOauth2"
          Oauth2ProviderConfigInput = {
            CustomOauth2ProviderConfig = local.oauth_provider_config
          }
        }
      }
    }

    # Both readOnly on the resource type, so GetAtt resolves them — this is what retires the
    # plan-time `data "external"` that used to shell out to the AWS CLI for the same two values.
    Outputs = {
      CredentialProviderArn = {
        Description = "Provider ARN, referenced by the gateway target's oauth credential config."
        Value       = { "Fn::GetAtt" = ["Provider", "CredentialProviderArn"] }
      }
      CallbackUrl = {
        Description = "Redirect URI to register on the Entra app (3LO/obo mode only)."
        Value       = { "Fn::GetAtt" = ["Provider", "CallbackUrl"] }
      }
    }
  })
}

# Drop the retired CLI shims from state without running their destroy provisioners.
#
# ⚠️ ONE-TIME MANUAL STEP before the first apply in an environment that already has this provider.
# `Name` is create-only on AWS::BedrockAgentCore::OAuth2CredentialProvider, so CloudFormation
# cannot adopt the existing one and CreateOauth2CredentialProvider collides on the name:
#
#   aws bedrock-agentcore-control delete-oauth2-credential-provider \
#     --name microsoft-graph-obo-provider --region <region>
#
# The provider ARN is DERIVED FROM THE NAME (.../token-vault/default/oauth2credentialprovider/<name>,
# verified live 2026-09-02), so the recreated provider gets the same ARN and the imported gateway
# target below keeps resolving. Graph tool calls fail between the delete and the apply.
#
# ⚠️ The callbackUrl does NOT survive: it embeds a server-generated UUID that changes on every
# create (verified live — two creates of the same name produced different UUIDs). That only matters
# in `obo` mode, where the URL is a registered Entra redirect URI; this environment runs
# client_credentials, which has no redirect leg. In obo mode, re-register the new value from the
# SSM parameter below on the Entra app after applying.
# (data.external.oauth_provider_info needs no `removed` block — a data source is not tracked as a
# managed object, so deleting its config is the whole removal.)
removed {
  from = null_resource.oauth_provider

  lifecycle {
    destroy = false
  }
}

# ============================================================
# Gateway Target — OpenAPI schema with TOKEN_EXCHANGE outbound auth
# ============================================================

resource "aws_bedrockagentcore_gateway_target" "graph" {
  count = var.enabled ? 1 : 0

  gateway_identifier = var.gateway_id
  name               = local.target_name
  description        = "Microsoft Graph (profile/mail/calendar/OneDrive/SharePoint/Teams) via OBO"

  target_configuration {
    mcp {
      open_api_schema {
        inline_payload {
          payload = local.openapi_schema
        }
      }
    }
  }

  # client_credentials (app-only, 2LO): the gateway acquires its OWN Graph token via
  # CLIENT_CREDENTIALS, independent of the inbound (Cognito) token — no token-exchange
  # custom_parameters, since there is no inbound assertion to swap.
  # obo (delegated, 3LO): TOKEN_EXCHANGE swaps the inbound assertion for a Graph token, and
  # requested_token_use=on_behalf_of is what tells Entra that is the swap being asked for.
  credential_provider_configuration {
    oauth {
      provider_arn = aws_cloudformation_stack.oauth_provider[0].outputs["CredentialProviderArn"]
      scopes       = local.oauth_scopes
      grant_type   = local.is_cc ? "CLIENT_CREDENTIALS" : "TOKEN_EXCHANGE"
      # An empty map would be sent as an empty customParameters object; omit the argument entirely
      # in client_credentials mode instead.
      custom_parameters = local.is_cc ? null : { requested_token_use = "on_behalf_of" }
    }
  }

  lifecycle {
    # Service-managed and undeclarable: the gateway injects allowed_request_headers, which would
    # otherwise show as a perpetual diff on every plan.
    ignore_changes = [metadata_configuration]
  }
}

removed {
  from = null_resource.gateway_target

  lifecycle {
    destroy = false
  }
}

# ============================================================
# SSM — callback URL for Entra app registration
# ============================================================

resource "aws_ssm_parameter" "callback_url" {
  count = var.enabled ? 1 : 0
  name  = "/${var.project_name}/${var.environment}/mcp/microsoft-graph-obo-callback-url"
  type  = "String"
  value = aws_cloudformation_stack.oauth_provider[0].outputs["CallbackUrl"]

  lifecycle {
    ignore_changes = [value]
  }
}
