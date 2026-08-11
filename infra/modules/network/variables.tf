variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "vpc_id" {
  description = "VPC the private subnets/endpoints are created in (default VPC in dev)."
  type        = string
}

variable "availability_zones" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
}

variable "private_subnet_cidrs" {
  description = "Two CIDRs for the private subnets (Lambdas + AgentCore Runtime)."
  type        = list(string)
  default     = ["172.31.110.0/24", "172.31.111.0/24"]
}

variable "nat_subnet_cidr" {
  description = "CIDR for the module-owned public subnet hosting the NAT gateway."
  type        = string
  default     = "172.31.108.0/24"
}

variable "enable_private_endpoints" {
  description = "When true (private-VPC deployment), add the interface VPC endpoints (Bedrock, AgentCore, SSM, Secrets, STS, ECS, ELB) so the frontend + backend reach every AWS dependency with NO NAT/IGW. Default false keeps just the base ecr/logs endpoints."
  type        = bool
  default     = false
}
