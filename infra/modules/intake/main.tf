####################################################################################
# Intake module: HTTP API Gateway (OIDC JWT) -> intake Lambda -> recon-items table.
# The single entry point for structured/semi-structured datasets. No normalization stage.
####################################################################################

# The Lambda deployment zip is built once by the shared lambda-package module (root contains
# the backend/ package); passed in via var.lambda_zip / var.lambda_source_hash.

# ---------------------------------------------------------------------------------
# IAM — least privilege: put items only
# ---------------------------------------------------------------------------------

# Used to scope the VPC-Lambda ENI create/delete actions to network interfaces in this
# account/region (these actions support resource-level permissions; Describe does not).
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "intake" {
  name               = "${var.name_prefix}-intake"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "intake" {
  name = "${var.name_prefix}-intake-policy"
  role = aws_iam_role.intake.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # VPC-attached Lambda ENI create/delete — scoped to this account/region. The resource
        # MUST stay broader than `network-interface/*`: ec2:CreateNetworkInterface also acts on
        # the subnet and the security group it attaches, so IAM evaluates it against those ARNs
        # too. Narrowing this to `network-interface/*` makes Lambda's CreateFunction pre-flight
        # check fail with "The provided execution role does not have permissions to call
        # CreateNetworkInterface on EC2". That failure only appears when the function is created
        # from scratch — an existing function is never re-validated — so it is easy to introduce
        # and not notice. Matches the scoping used by the sibling gl-mock/idp-hook/recon-agent
        # modules.
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface"]
        Resource = "arn:aws:ec2:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        # ec2:DescribeNetworkInterfaces does not support resource-level scoping (must use "*").
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },

      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = var.items_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------------

resource "aws_lambda_function" "intake" {
  function_name    = "${var.name_prefix}-intake"
  role             = aws_iam_role.intake.arn
  runtime          = "python3.12"
  handler          = "backend.intake.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 30

  environment {
    variables = {
      ITEMS_TABLE = var.items_table
    }
  }
}

# ---------------------------------------------------------------------------------
# HTTP API Gateway with an OIDC JWT authorizer
# ---------------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
}

# A v2 JWT authorizer is not Cognito-specific: it validates any OIDC issuer, which is why this stack
# no longer runs a user pool. Issuer and audience are derived from `auth_provider` in the root module,
# the same way chatbot-app/frontend/src/lib/api-auth.ts derives them for the BFF — so the two verifiers
# agree by construction rather than by someone remembering to change both.
#
# API Gateway fetches the provider's JWKS from AWS-managed infrastructure, NOT from this VPC. That is
# what keeps this authorizer working in a no-NAT private deployment, and it is the reason the private
# REST API in private_api.tf uses SigV4 instead of a Lambda authorizer doing the same job in-VPC.
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.name_prefix}-oidc-jwt"

  jwt_configuration {
    audience = [var.jwt_audience]
    issuer   = var.jwt_issuer
  }
}

resource "aws_apigatewayv2_integration" "intake" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.intake.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "post_items" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /items"
  target             = "integrations/${aws_apigatewayv2_integration.intake.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Access-log destination for the intake HTTP API stage.
resource "aws_cloudwatch_log_group" "intake_access" {
  #checkov:skip=CKV_AWS_158:Logs use the default CloudWatch-managed key; a customer-managed CMK adds overhead not warranted for demo access logs.
  name              = "/aws/apigateway/${var.name_prefix}-intake"
  retention_in_days = 365
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Emit a structured access log per request (who called what, and the response status/latency).
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.intake_access.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.intake.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
