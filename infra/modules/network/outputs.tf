output "private_subnet_ids" {
  description = "Private subnet ids for VPC-attached Lambdas and the AgentCore Runtime."
  value       = aws_subnet.private[*].id
}

output "security_group_id" {
  description = "Shared egress-only SG for VPC-attached compute."
  value       = aws_security_group.compute.id
}

output "s3_endpoint_id" {
  value = aws_vpc_endpoint.s3.id
}

output "dynamodb_endpoint_id" {
  value = aws_vpc_endpoint.dynamodb.id
}

output "vpc_cidr" {
  description = "The VPC CIDR — the default private-mode ALB ingress range."
  value       = data.aws_vpc.this.cidr_block
}
