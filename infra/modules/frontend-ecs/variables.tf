variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "frontend_dir" {
  description = "Absolute path to the Next.js frontend (build context)."
  type        = string
}

variable "vpc_id" {
  description = "VPC to run ECS + ALB in (default VPC in dev)."
  type        = string
}

variable "public_subnet_cidrs" {
  description = "Two /24 CIDRs (in two AZs) for the module-managed public subnets used by the ALB + Fargate."
  type        = list(string)
  default     = ["172.31.100.0/24", "172.31.101.0/24"]
}

# ---------------------------------------------------------------------------------
# Private-VPC deployment (single feature flag).
# ---------------------------------------------------------------------------------
variable "private_vpc" {
  description = <<-EOT
    When true, deploy the frontend fully PRIVATE: NO CloudFront, NO public endpoints. The ALB
    becomes internal, the Fargate task runs on the passed-in private subnets with no public IP,
    and inbound is restricted to private_ingress_cidrs. Reach it via VPN / Direct Connect / SSM
    port-forward. When false (DEFAULT) the public CloudFront -> internet-facing-ALB topology is
    used unchanged. Requires private_subnet_ids + ecs_security_group_id (the network module's
    private subnets + its interface VPC endpoints, incl. enable_private_endpoints=true) so the
    task can pull its image / reach AWS APIs with no NAT or IGW.
  EOT
  type        = bool
  default     = false
}

variable "private_subnet_ids" {
  description = "Private subnet ids (>=2 AZs) for the ALB + Fargate when private_vpc=true. Ignored when false."
  type        = list(string)
  default     = []
}

variable "private_ingress_cidrs" {
  description = "CIDRs allowed to reach the internal ALB when private_vpc=true (e.g. VPN/corporate ranges). Empty defaults to the VPC CIDR only."
  type        = list(string)
  default     = []
}

variable "vpc_cidr" {
  description = "VPC CIDR — the default private-mode ALB ingress range when private_ingress_cidrs is empty."
  type        = string
  default     = ""
}

variable "ecs_private_security_group_id" {
  description = "Security group for the Fargate task in private mode (from the network module — allows egress to the VPC interface endpoints). Ignored when private_vpc=false."
  type        = string
  default     = ""
}

variable "availability_zones" {
  description = "Two AZs for the public subnets (ALB requires >=2 AZs)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

# --- Build-time NEXT_PUBLIC_* wiring (Cognito OAuth + recon BFF) ---

variable "recon_api_base" {
  description = "Base URL of the recon BFF/API (CloudFront-agnostic; the HTTP API endpoint)."
  type        = string
}

variable "cognito_hosted_ui" {
  description = "Cognito Hosted UI domain (e.g. prefix.auth.us-east-1.amazoncognito.com)."
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito SPA app client id."
  type        = string
}

# --- Auth provider selection (Okta OIDC vs Entra) ---
variable "auth_provider" {
  description = "Frontend identity provider: 'entra' (default) or 'okta'. Baked into the build."
  type        = string
  default     = "entra"
}

variable "okta_issuer" {
  description = "Okta OIDC issuer URL (e.g. https://<org>.okta.com/oauth2/default). Empty unless auth_provider=okta."
  type        = string
  default     = ""
}

variable "okta_client_id" {
  description = "Okta OIDC app client id. Empty unless auth_provider=okta."
  type        = string
  default     = ""
}

# Pinning this is what stops the callback URL drifting (live-QA P0-1). Left empty, the frontend
# derives the URI from whatever origin the browser is on — which is a generated *.cloudfront.net
# domain that changes whenever the distribution is recreated, so the URI registered on the Okta
# app stops matching and login fails. Set it to a URL you control (custom domain, or a
# distribution domain you intend to keep) and register that same value on the Okta app.
variable "okta_redirect_uri" {
  description = "Pinned Okta OIDC callback URL, e.g. https://recon.example.com/login/callback. Must end in /login/callback. Empty = derive from the browser origin (fine for local dev; drifts in a deployed environment)."
  type        = string
  default     = ""

  validation {
    condition     = var.okta_redirect_uri == "" || can(regex("^https?://.+/login/callback$", var.okta_redirect_uri))
    error_message = "okta_redirect_uri must be an absolute http(s) URL ending in /login/callback (or empty to derive it from the browser origin)."
  }
}

# --- BFF data access (same-origin Next.js API routes read these via the ECS task role) ---

variable "cases_table" {
  description = "recon-cases table name (read by the /api/recon/cases* BFF routes)."
  type        = string
}

variable "cases_table_arn" {
  type = string
}

variable "audit_table" {
  description = "recon-audit table name."
  type        = string
}

variable "audit_table_arn" {
  type = string
}

variable "assets_bucket" {
  description = "Assets bucket holding skills-catalog.json (read by the /api/recon/skills route)."
  type        = string
}

variable "assets_bucket_arn" {
  type = string
}

# --- Lessons-learned ledger (read by /api/recon/lessons, written on approve/reject) ---

variable "lessons_table" {
  description = "recon-lessons table name."
  type        = string
}

variable "lessons_table_arn" {
  type = string
}

# --- Approve email + reprocess re-invocation ---

variable "notify_email" {
  description = "Recipient address for approval notifications, sent from the shared mailbox via the microsoft-graph gateway tool. Empty disables the email step."
  type        = string
  default     = ""
}

variable "counterparty_email_domains" {
  description = "Domains an analyst may address a counterparty email draft to, joined into COUNTERPARTY_EMAIL_DOMAINS. Empty allows nothing. The BFF checks this when persisting the draft; the gateway interceptor checks it again on the send, so this copy is early feedback rather than the boundary."
  type        = list(string)
  default     = []
}

variable "graph_mailbox" {
  description = "Shared mailbox SMTP address the approval notification is sent FROM (Graph sendSharedMailboxMail). Empty disables the email step."
  type        = string
  default     = ""
}

variable "egress_gateway_url" {
  description = "Egress tools gateway URL — the BFF calls microsoft-graph___sendSharedMailboxMail through it (SigV4)."
  type        = string
  default     = ""
}

variable "reprocess_cap" {
  description = "Max number of times a case may be re-processed before it is aged out."
  type        = number
  default     = 3
}

variable "agent_runtime_arn" {
  description = "AgentCore Runtime ARN re-invoked on re-process. Empty disables re-invocation (case just returns to IN_PROGRESS)."
  type        = string
  default     = ""
}

variable "agent_worker_function_arn" {
  description = "ARN of the agent-worker Lambda the reject→reprocess path invokes async (honors the runtime⇄harness backend switch; '' disables re-invocation)."
  type        = string
  default     = ""
}

variable "policy_engine_name" {
  description = "AgentCore Policy engine name whose gated Cedar policies the Config tab rewrites on threshold change ('' disables policy editing)."
  type        = string
  default     = ""
}

variable "egress_gateway_arn" {
  description = "Egress tools gateway ARN — pinned in the gated Cedar statements the Config tab rewrites."
  type        = string
  default     = ""
}

# --- Config tab: Tier-1 toggle (SSM) ---

variable "tier1_enabled_param" {
  description = "Name of the SSM parameter toggling the deterministic Tier-1 route."
  type        = string
}

# --- Lessons -> AgentCore Memory (BFF writes decision events) ---

variable "recon_memory_id" {
  description = "AgentCore Memory id the BFF writes lesson events into. Empty disables the memory feed."
  type        = string
  default     = ""
}

variable "recon_memory_arn" {
  description = "ARN of the recon AgentCore Memory (CreateEvent IAM)."
  type        = string
  default     = ""
}

variable "auto_resolve_param" {
  description = "SSM parameter name for the auto-resolve confidence threshold (Config tab)."
  type        = string
  default     = ""
}

variable "comment_requirement_param" {
  description = "SSM parameter name for the decision-comment requirement (Config tab + enforcement)."
  type        = string
  default     = ""
}

# --- Harness backend selector + evals (Config + Evals tabs) ---
variable "agent_backend_param" {
  description = "SSM parameter name of the runtime agent-backend selector (runtime|harness)."
  type        = string
  default     = ""
}

variable "harness_config_version_param" {
  description = "SSM parameter name of the active harness config-version pointer."
  type        = string
  default     = ""
}

variable "eval_results_log_group_prefix" {
  description = "Name prefix of the service-generated eval results log groups (BFF discovers the actual groups via DescribeLogGroups)."
  type        = string
  default     = ""
}

variable "harness_log_group" {
  description = "CloudWatch log group of harness OTel traces/spans (batch eval + recommendations data source)."
  type        = string
  default     = "aws/spans"
}

variable "harness_service_name" {
  description = "OTel service.name of the harness backend (batch eval + recommendations data-source filter). The old in-code default 'bedrock-agentcore' matches nothing."
  type        = string
}

variable "analyst_agreement_evaluator_id" {
  description = "Real evaluator id of the custom analyst-agreement evaluator (name + service-generated suffix); the batch route maps the UI's 'analyst_agreement' alias to it."
  type        = string
  default     = ""
}

variable "backend_service_names" {
  description = "OTel service.name per agent backend (harness/runtime); batch evals + decision-triggered re-scores pick the entry matching the active backend (SSM agent-backend param)."
  type        = map(string)
  default     = {}
}

variable "backend_event_log_groups" {
  description = "Per-backend runtime log group holding OTel gen-ai event records; included in batch-eval data sources for the same reason as the online configs (the eval service reads content only from configured groups)."
  type        = map(string)
  default     = {}
}

variable "email_confirmation_token" {
  description = "Shared secret attached to approve/notify email sends so the gateway interceptor's human-confirmation gate permits them. Never provisioned to the agent runtime."
  type        = string
  default     = ""
  sensitive   = true
}
