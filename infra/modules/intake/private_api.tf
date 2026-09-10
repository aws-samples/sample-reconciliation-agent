####################################################################################
# Private intake door: a PRIVATE REST API in front of the SAME intake Lambda.
#
# Only created when private_api_enabled = true (the root wires this from `private_vpc`).
#
# Why a second API rather than a setting on the first one: an API Gateway v2 HTTP API cannot be made
# private. The PRIVATE endpoint type, resource policies and the execute-api interface endpoint are all
# v1 (REST) features, so under private_vpc = true the HTTP API in main.tf stays internet-facing with
# the JWT authorizer as its only control. This file is the private path.
#
# Why it integrates the SAME Lambda rather than a private copy of the handler: ReconItem is built in
# exactly one place, and the all-or-nothing batch validation, the conditional put and the `written`
# count are properties of backend/intake/handler.py. A duplicated handler would drift, and the drift
# would only show up as a payload one door accepts and the other rejects.
#
# See assets/intake-http-api.md for the caller-facing contract.
####################################################################################

# ---------------------------------------------------------------------------------
# The API and its resource policy
# ---------------------------------------------------------------------------------

resource "aws_api_gateway_rest_api" "private" {
  count = var.private_api_enabled ? 1 : 0

  name        = "${var.name_prefix}-intake-private"
  description = "Private (VPC-only) door onto the ${var.name_prefix}-intake Lambda."

  endpoint_configuration {
    types = ["PRIVATE"]
    # Associating the endpoint is what publishes the
    # <api-id>-<vpce-id>.execute-api.<region>.vpce.amazonaws.com hostname. Without it the only way in
    # is the endpoint's own DNS name plus an x-apigw-api-id header, which every caller then has to
    # know about.
    vpc_endpoint_ids = [var.execute_api_vpc_endpoint_id]
  }

  # Allow-everything, then deny anything that did not arrive through OUR interface endpoint. The Deny
  # is the whole control: a PRIVATE endpoint type alone still accepts traffic from any VPC endpoint in
  # any account that can reach the service, so without this an unrelated VPCE is a valid front door.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = "*"
        Action    = "execute-api:Invoke"
        Resource  = "execute-api:/*"
      },
      {
        Effect    = "Deny"
        Principal = "*"
        Action    = "execute-api:Invoke"
        Resource  = "execute-api:/*"
        Condition = {
          StringNotEquals = { "aws:SourceVpce" = var.execute_api_vpc_endpoint_id }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------------
# POST /items -> intake Lambda
# ---------------------------------------------------------------------------------

resource "aws_api_gateway_resource" "items" {
  count = var.private_api_enabled ? 1 : 0

  rest_api_id = aws_api_gateway_rest_api.private[0].id
  parent_id   = aws_api_gateway_rest_api.private[0].root_resource_id
  path_part   = "items"
}

resource "aws_api_gateway_method" "post_items" {
  count = var.private_api_enabled ? 1 : 0

  rest_api_id = aws_api_gateway_rest_api.private[0].id
  resource_id = aws_api_gateway_resource.items[0].id
  http_method = "POST"

  # SigV4, not a bearer token. A REST API has no native OIDC authorizer — COGNITO_USER_POOLS is
  # Cognito-only and this stack no longer runs a user pool — so the alternative was a Lambda authorizer
  # verifying Okta JWTs, which would have to fetch Okta's JWKS from INSIDE this VPC. A VPC-only endpoint
  # whose authorization depends on internet egress fails closed the moment the NAT is removed, which is
  # the one deployment this API exists for. IAM also matches both AgentCore gateways, needs no new
  # dependency in the shared Lambda zip, and is auditable per-principal in CloudTrail.
  #
  # Callers therefore need credentials plus execute-api:Invoke on this method, not a token.
  authorization = "AWS_IAM"
}

resource "aws_api_gateway_integration" "items" {
  count = var.private_api_enabled ? 1 : 0

  rest_api_id = aws_api_gateway_rest_api.private[0].id
  resource_id = aws_api_gateway_resource.items[0].id
  http_method = aws_api_gateway_method.post_items[0].http_method
  type        = "AWS_PROXY"
  # Always POST for a Lambda proxy integration, regardless of the method's own verb — this is the verb
  # API Gateway uses to call Lambda, not the one the client sent.
  integration_http_method = "POST"
  uri                     = aws_lambda_function.intake.invoke_arn
}

# ---------------------------------------------------------------------------------
# Deployment + stage
# ---------------------------------------------------------------------------------

resource "aws_api_gateway_deployment" "private" {
  count = var.private_api_enabled ? 1 : 0

  rest_api_id = aws_api_gateway_rest_api.private[0].id

  # A REST API only serves what has been DEPLOYED, so every one of these has to force a new
  # deployment. The resource policy is in the hash for a reason that is easy to miss: a policy edit
  # does not take effect until the API is redeployed, so leaving it out would leave a tightened (or
  # loosened) policy silently inactive until some unrelated change happened to trigger a deploy.
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.items[0].id,
      aws_api_gateway_method.post_items[0].id,
      aws_api_gateway_integration.items[0].id,
      aws_api_gateway_rest_api.private[0].policy,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "v1" {
  #checkov:skip=CKV_AWS_76:Access logging is deliberately absent — see the comment below.
  #checkov:skip=CKV_AWS_73:X-Ray tracing on this stage would duplicate the Lambda's own instrumentation.
  #checkov:skip=CKV_AWS_120:Response caching on a write endpoint would be wrong.
  count = var.private_api_enabled ? 1 : 0

  rest_api_id   = aws_api_gateway_rest_api.private[0].id
  deployment_id = aws_api_gateway_deployment.private[0].id
  stage_name    = "v1"

  # No access_log_settings, unlike the public HTTP API's stage. REST-API CloudWatch logging requires an
  # IAM role ARN in API Gateway's ACCOUNT settings, which is a per-account singleton
  # (aws_api_gateway_account): a stack that manages it silently overwrites whatever any other stack in
  # the account set, and this environment shares its account. The cost is real — a request rejected by
  # the resource policy or the authorizer leaves no trace anywhere, since it never reaches the Lambda —
  # so the enabling step is listed in the root module's post_deploy_checklist output rather than left
  # to be discovered.
}

resource "aws_lambda_permission" "private_apigw" {
  count = var.private_api_enabled ? 1 : 0

  # Must not collide with the public API's "AllowAPIGatewayInvoke" statement on the same function.
  statement_id  = "AllowAPIGatewayInvokePrivate"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.intake.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.private[0].execution_arn}/*/*"
}
