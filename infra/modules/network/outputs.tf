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

output "execute_api_endpoint_id" {
  description = <<-EOT
    Id of the execute-api interface endpoint, or "" when enable_private_endpoints = false.
    The private intake REST API's resource policy is keyed on it, so an empty value must reach the
    consumer as an empty string rather than an error: modules/intake validates it and fails the plan
    with a message naming the variable, which is a far clearer failure than a `key not found` here.
  EOT
  value       = try(aws_vpc_endpoint.interfaces["execute-api"].id, "")
}

output "vpc_cidr" {
  description = "The VPC CIDR — the default private-mode ALB ingress range."
  value       = data.aws_vpc.this.cidr_block
}
