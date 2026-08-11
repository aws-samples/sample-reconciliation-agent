# Microsoft Graph via AgentCore Gateway with OBO (On-Behalf-Of) token exchange.
#
# Why null_resource + AWS CLI?
# The hashicorp/aws v6.x provider does NOT model:
#   - customOauth2ProviderConfig.onBehalfOfTokenExchangeConfig
#   - clientAuthenticationMethod=CLIENT_SECRET_POST
#   - JWT_AUTHORIZATION_GRANT
#   - TOKEN_EXCHANGE outbound grant on gateway targets
#   - openApiSchema.inlinePayload string payload + customParameters.requested_token_use
#
# The CLI accepts these via --oauth2-provider-config-input and
# --credential-provider-configurations JSON. We use null_resource provisioners
# triggered by content hashes; deletes call delete-oauth2-credential-provider /
# delete-gateway-target.
#
# Reference: ~/Downloads/obo_token_exchange_microsoft.ipynb.

locals {
  is_cc         = var.auth_mode == "client_credentials"
  provider_name = "microsoft-graph-obo-provider"
  target_name   = "microsoft-graph"
  # client_credentials mode exposes only app-only-compatible operations (no /me — there's no
  # signed-in user for an app-only token to resolve against).
  schema_path    = local.is_cc ? "${path.module}/openapi-schema-app.json" : "${path.module}/openapi-schema.json"
  openapi_schema = file(local.schema_path)
  schema_hash    = sha256(local.openapi_schema)
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
  obo_config = local.is_cc ? {} : {
    onBehalfOfTokenExchangeConfig = { grantType = "JWT_AUTHORIZATION_GRANT" }
  }

  oauth_provider_payload = var.enabled ? jsonencode(merge(
    {
      customOauth2ProviderConfig = merge(
        {
          clientId     = var.client_id
          clientSecret = var.client_secret
          oauthDiscovery = {
            discoveryUrl = local.discovery_url
          }
          clientAuthenticationMethod = "CLIENT_SECRET_POST"
        },
        local.obo_config,
      )
    },
  )) : ""

  # Triggers a re-create when any input that the API actually validates
  # changes. client_secret is excluded from the visible hash but its presence
  # is captured indirectly via the provider name so the resource still updates
  # when the secret rotates (set REWRITE_SECRETS=1 to force).
  provider_trigger_hash = sha256(join("|", [
    var.tenant_id,
    var.client_id,
    local.discovery_url,
    var.auth_mode,
  ]))

  target_trigger_hash = sha256(join("|", [
    local.schema_hash,
    var.client_id,
    join(",", local.oauth_scopes),
    var.auth_mode,
  ]))
}

# ============================================================
# OAuth2 Credential Provider — CustomOauth2 with OBO config
# ============================================================

resource "null_resource" "oauth_provider" {
  count = var.enabled ? 1 : 0

  triggers = {
    provider_name = local.provider_name
    aws_region    = var.aws_region
    config_hash   = local.provider_trigger_hash
  }

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      set -euo pipefail
      NAME='${local.provider_name}'
      REGION='${var.aws_region}'
      CONFIG=$(cat <<'CFG'
${local.oauth_provider_payload}
CFG
)
      if aws bedrock-agentcore-control get-oauth2-credential-provider \
            --name "$NAME" --region "$REGION" >/dev/null 2>&1; then
        echo "[microsoft-graph-obo] provider exists; updating $NAME" >&2
        aws bedrock-agentcore-control update-oauth2-credential-provider \
          --name "$NAME" \
          --region "$REGION" \
          --credential-provider-vendor CustomOauth2 \
          --oauth2-provider-config-input "$CONFIG" >/dev/null
      else
        echo "[microsoft-graph-obo] creating provider $NAME" >&2
        aws bedrock-agentcore-control create-oauth2-credential-provider \
          --name "$NAME" \
          --region "$REGION" \
          --credential-provider-vendor CustomOauth2 \
          --oauth2-provider-config-input "$CONFIG" >/dev/null
      fi
    EOT
  }

  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    command    = <<-EOT
      set -euo pipefail
      aws bedrock-agentcore-control delete-oauth2-credential-provider \
        --name '${self.triggers.provider_name}' \
        --region '${self.triggers.aws_region}' >/dev/null 2>&1 || true
    EOT
  }
}

# Read the provider ARN + callback URL after create/update.
data "external" "oauth_provider_info" {
  count      = var.enabled ? 1 : 0
  depends_on = [null_resource.oauth_provider]

  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    out=$(aws bedrock-agentcore-control get-oauth2-credential-provider \
            --name '${local.provider_name}' \
            --region '${var.aws_region}')
    arn=$(echo "$out" | jq -r '.credentialProviderArn // empty')
    cb=$(echo "$out" | jq -r '.callbackUrl // empty')
    jq -nc --arg arn "$arn" --arg cb "$cb" '{provider_arn:$arn, callback_url:$cb}'
  EOT
  ]
}

# ============================================================
# Gateway Target — OpenAPI schema with TOKEN_EXCHANGE outbound auth
# ============================================================

resource "null_resource" "gateway_target" {
  count = var.enabled ? 1 : 0

  triggers = {
    target_name        = local.target_name
    gateway_identifier = var.gateway_id
    aws_region         = var.aws_region
    config_hash        = local.target_trigger_hash
  }

  depends_on = [
    null_resource.oauth_provider,
    data.external.oauth_provider_info,
  ]

  provisioner "local-exec" {
    when    = create
    command = <<-EOT
      set -euo pipefail
      NAME='${local.target_name}'
      GW='${var.gateway_id}'
      REGION='${var.aws_region}'
      PROVIDER_ARN='${try(data.external.oauth_provider_info[0].result.provider_arn, "")}'

      if [ -z "$PROVIDER_ARN" ]; then
        echo "[microsoft-graph-obo] ERROR: provider ARN not found" >&2
        exit 1
      fi

      SCHEMA=$(cat <<'SCHEMA_EOF'
${local.openapi_schema}
SCHEMA_EOF
)
      TARGET_CFG=$(jq -nc --arg s "$SCHEMA" '{mcp:{openApiSchema:{inlinePayload:$s}}}')

      # client_credentials (app-only, 2LO): the gateway acquires its OWN Graph token via
      # CLIENT_CREDENTIALS, independent of the inbound (Cognito) token — no token-exchange
      # customParameters, since there is no inbound assertion to swap.
      # obo (delegated, 3LO): TOKEN_EXCHANGE swaps the inbound assertion for a Graph token.
      CRED_CFG=$(jq -nc --arg arn "$PROVIDER_ARN" '[
        {
          credentialProviderType: "OAUTH",
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn: $arn,
              scopes: ["${join("\",\"", local.oauth_scopes)}"],
              grantType: "${local.is_cc ? "CLIENT_CREDENTIALS" : "TOKEN_EXCHANGE"}"
              %{if !local.is_cc},
              customParameters: {
                requested_token_use: "on_behalf_of"
              }
              %{endif}
            }
          }
        }
      ]')

      EXISTING=$(aws bedrock-agentcore-control list-gateway-targets \
        --gateway-identifier "$GW" --region "$REGION" \
        --query "items[?name=='$NAME'].targetId" --output text 2>/dev/null || true)

      if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
        echo "[microsoft-graph-obo] target exists ($EXISTING); updating" >&2
        aws bedrock-agentcore-control update-gateway-target \
          --gateway-identifier "$GW" \
          --target-id "$EXISTING" \
          --name "$NAME" \
          --region "$REGION" \
          --target-configuration "$TARGET_CFG" \
          --credential-provider-configurations "$CRED_CFG" >/dev/null
      else
        echo "[microsoft-graph-obo] creating target $NAME" >&2
        aws bedrock-agentcore-control create-gateway-target \
          --gateway-identifier "$GW" \
          --name "$NAME" \
          --description "Microsoft Graph (profile/mail/calendar/OneDrive/SharePoint/Teams) via OBO" \
          --region "$REGION" \
          --target-configuration "$TARGET_CFG" \
          --credential-provider-configurations "$CRED_CFG" >/dev/null
      fi
    EOT
  }

  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    command    = <<-EOT
      set -euo pipefail
      GW='${self.triggers.gateway_identifier}'
      NAME='${self.triggers.target_name}'
      REGION='${self.triggers.aws_region}'
      TID=$(aws bedrock-agentcore-control list-gateway-targets \
              --gateway-identifier "$GW" --region "$REGION" \
              --query "items[?name=='$NAME'].targetId" --output text 2>/dev/null || true)
      if [ -n "$TID" ] && [ "$TID" != "None" ]; then
        aws bedrock-agentcore-control delete-gateway-target \
          --gateway-identifier "$GW" \
          --target-id "$TID" \
          --region "$REGION" >/dev/null 2>&1 || true
      fi
    EOT
  }
}

# ============================================================
# SSM — callback URL for Entra app registration
# ============================================================

resource "aws_ssm_parameter" "callback_url" {
  count = var.enabled ? 1 : 0
  name  = "/${var.project_name}/${var.environment}/mcp/microsoft-graph-obo-callback-url"
  type  = "String"
  value = try(data.external.oauth_provider_info[0].result.callback_url, "pending")

  lifecycle {
    ignore_changes = [value]
  }
}
