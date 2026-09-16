####################################################################################
# BFF module: skills-catalog Lambda on a JWT-protected route of the shared HTTP API.
#
# The skills catalog is deliberately the WHOLE of this API's surface. Case decisions
# (queue/approve/reject) do not belong here: they run in the frontend's same-origin BFF routes,
# which act through the egress gateway's platform tools (recon_update_status, set_draw_status), so
# there is exactly one HITL code path. Adding a decision route here would create a second.
####################################################################################

# The Lambda deployment zip is built once by the shared lambda-package module (root contains
# the backend/ package); passed in via var.lambda_zip / var.lambda_source_hash.

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

# ---------------------------------------------------------------------------------
# skills-catalog BFF Lambda (read-only S3)
# ---------------------------------------------------------------------------------

resource "aws_iam_role" "skills" {
  name               = "${var.name_prefix}-skills-bff"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "skills" {
  name = "${var.name_prefix}-skills-bff-policy"
  role = aws_iam_role.skills.id
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
        Action   = ["s3:GetObject"]
        Resource = "${var.assets_bucket_arn}/skills-catalog.json"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_lambda_function" "skills" {
  function_name    = "${var.name_prefix}-skills-bff"
  role             = aws_iam_role.skills.arn
  runtime          = "python3.12"
  handler          = "backend.skills_api.handler.handle"
  filename         = var.lambda_zip
  source_code_hash = var.lambda_source_hash

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  timeout = 15

  environment {
    variables = {
      ASSETS_BUCKET      = var.assets_bucket
      SKILLS_CATALOG_KEY = "skills-catalog.json"
    }
  }
}

# ---------------------------------------------------------------------------------
# Routes on the shared HTTP API (all JWT-protected)
# ---------------------------------------------------------------------------------

locals {
  skills_routes = ["GET /skills"]
}

resource "aws_apigatewayv2_integration" "skills" {
  api_id                 = var.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.skills.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "skills" {
  for_each           = toset(local.skills_routes)
  api_id             = var.api_id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.skills.id}"
  authorization_type = "JWT"
  authorizer_id      = var.authorizer_id
}

resource "aws_lambda_permission" "skills" {
  statement_id  = "AllowAPIGatewayInvokeSkills"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.skills.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/*/*"
}
