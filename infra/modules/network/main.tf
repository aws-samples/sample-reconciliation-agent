####################################################################################
# Private networking for the recon platform inside the (default) VPC:
#   - two private subnets (Lambdas + AgentCore Runtime attach here)
#   - one NAT gateway (in a module-owned public subnet) for AWS-API egress
#   - S3 + DynamoDB GATEWAY VPC endpoints (PrivateLink) on the private route table,
#     so S3/DynamoDB traffic never leaves the AWS network
#   - a shared egress-only security group
####################################################################################

data "aws_vpc" "this" {
  id = var.vpc_id
}

data "aws_internet_gateway" "this" {
  filter {
    name   = "attachment.vpc-id"
    values = [var.vpc_id]
  }
}

# Public subnet hosting the NAT gateway.
resource "aws_subnet" "nat" {
  #checkov:skip=CKV_AWS_130:This subnet exists specifically to host the NAT gateway, which must be in a public subnet with a public IP; workload subnets remain private behind this NAT.
  vpc_id                  = var.vpc_id
  cidr_block              = var.nat_subnet_cidr
  availability_zone       = var.availability_zones[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.name_prefix}-nat" }
}

resource "aws_route_table" "nat_public" {
  vpc_id = var.vpc_id
  tags   = { Name = "${var.name_prefix}-nat-public" }
}

resource "aws_route" "nat_igw" {
  route_table_id         = aws_route_table.nat_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = data.aws_internet_gateway.this.id
}

resource "aws_route_table_association" "nat" {
  subnet_id      = aws_subnet.nat.id
  route_table_id = aws_route_table.nat_public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-nat" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.nat.id
  tags          = { Name = "${var.name_prefix}-nat" }
}

# Private subnets (two AZs) for Lambdas + the AgentCore Runtime.
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = var.vpc_id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = { Name = "${var.name_prefix}-private-${count.index}" }
}

resource "aws_route_table" "private" {
  vpc_id = var.vpc_id
  tags   = { Name = "${var.name_prefix}-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# PrivateLink (gateway endpoints): S3 + DynamoDB traffic stays on the AWS network —
# these prefix-list routes take precedence over the NAT default route.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name_prefix}-s3" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name_prefix}-dynamodb" }
}

# Shared security group for VPC-attached compute (egress only; nothing dials in).
resource "aws_security_group" "compute" {
  name        = "${var.name_prefix}-private-compute"
  description = "Recon VPC-attached Lambdas + AgentCore Runtime (egress only)"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Interface endpoints required for VPC-mode AgentCore Runtime container image refresh
# (ECR api/dkr) and runtime logging — per the AgentCore VPC guide. Endpoint ENIs share the
# compute SG; the self-referencing 443 rule lets compute reach them.
resource "aws_security_group_rule" "endpoints_https" {
  # Private DNS on the interface endpoints applies VPC-WIDE: every ECR/logs call in the VPC
  # (including the frontend ECS tasks in public subnets) resolves to the endpoint ENIs. The
  # rule must therefore admit the whole VPC CIDR, not just the compute SG — otherwise image
  # pulls outside the compute SG fail with ResourceInitializationError.
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.compute.id
  cidr_blocks       = [data.aws_vpc.this.cidr_block]
  description       = "Interface VPC endpoints (443) from the whole VPC"
}

# Base interface endpoints (always): image refresh + logging for VPC-mode compute. When
# enable_private_endpoints=true (private-VPC deployment with NO NAT/IGW), add the endpoints the
# frontend + Lambdas + agent need to reach every AWS dependency privately: Bedrock (models),
# AgentCore data plane, SSM/Secrets/STS, the ECS + ELB control planes for Fargate, and X-Ray for
# span export.
locals {
  _base_interface_endpoints = ["ecr.api", "ecr.dkr", "logs"]
  _private_interface_endpoints = [
    "bedrock-runtime", "bedrock-agentcore", "ssm", "secretsmanager", "sts",
    "ecs", "ecs-agent", "ecs-telemetry", "elasticloadbalancing",
    # OTel span export goes to xray.<region>.amazonaws.com. Without this endpoint a VPC-attached
    # Lambda in private mode drops every span while otherwise working normally — a silent gap.
    "xray",
    # Bedrock Knowledge Base Retrieve is served by bedrock-agent-runtime, which is a DIFFERENT
    # service from bedrock-runtime (model inference). The KB tool Lambda
    # (backend/kb_tool/handler.py) builds boto3.client("bedrock-agent-runtime"), so without this
    # endpoint search_guidance / the consult-guidance skill hangs in a no-NAT deployment.
    "bedrock-agent-runtime",
    # AgentCore Gateway has its OWN PrivateLink service, separate from the bedrock-agentcore data
    # plane. It is not redundant: the gateway's private DNS is the wildcard
    # *.gateway.bedrock-agentcore.<region>.amazonaws.com, which the bedrock-agentcore endpoint's
    # exact-name zone (bedrock-agentcore.<region>.amazonaws.com) does not resolve. Both recon
    # gateways use AWS_IAM/SigV4 inbound auth, so the default full-access endpoint policy is
    # sufficient — a gateway with OAuth/JWT ingress would additionally need Principal "*" in the
    # endpoint policy, because endpoint policies can only match IAM principals.
    "bedrock-agentcore.gateway",
  ]
  interface_endpoints = toset(
    var.enable_private_endpoints
    ? concat(local._base_interface_endpoints, local._private_interface_endpoints)
    : local._base_interface_endpoints
  )
}

resource "aws_vpc_endpoint" "interfaces" {
  for_each = local.interface_endpoints

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.compute.id]
  private_dns_enabled = true

  tags = { Name = "${var.name_prefix}-${each.value}" }
}
