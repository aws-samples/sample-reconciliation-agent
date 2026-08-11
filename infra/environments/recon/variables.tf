variable "region" {
  description = "AWS region for the recon platform."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
  default     = "recon-dev"
}

variable "hosted_ui_prefix" {
  description = "Cognito Hosted UI domain prefix (must be globally unique)."
  type        = string
  default     = "recon-dev-login"
}

variable "idp_gateway_target_url" {
  description = "Endpoint of the independently-deployed IDP (document-extraction) MCP/agent, registered as a Gateway target. Empty disables the target."
  type        = string
  default     = ""
}

variable "recon_domain" {
  description = "Recon domain the IDP hook stamps on ingested items."
  type        = string
  default     = "cash"
}

variable "idp_mcp_secret_json" {
  description = "JSON {token_url, client_id, client_secret, scope} for IDP MCP client-credentials. Empty disables."
  type        = string
  default     = ""
  sensitive   = true
}

variable "graph_enabled" {
  type    = bool
  default = false
}
variable "entra_tenant_id" {
  type    = string
  default = ""
}
variable "entra_client_id" {
  type    = string
  default = ""
}
variable "entra_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

# --- Approval email + reprocess cap ---

variable "notify_email" {
  description = "Recipient for case-approval / auto-resolve emails, sent from the shared mailbox via the microsoft-graph gateway tool. Empty disables the email step."
  type        = string
  default     = ""
}

variable "graph_secret_json" {
  description = "Deprecated: retained for compatibility. The agent now sends/reads mail through the existing microsoft-graph OpenAPI gateway target, which owns its own Entra credentials."
  type        = string
  default     = ""
  sensitive   = true
}

# No default on purpose: a mailbox address identifies a real tenant, so it belongs in the
# gitignored terraform.tfvars rather than in committed code. Terraform stops and names this
# variable if it is unset, which beats silently sending from someone else's mailbox. Set it to
# the empty string to run without the Graph email step.
variable "graph_mailbox" {
  description = "Shared mailbox SMTP address the agent's Graph email tools send from / read. Must be a real mailbox in the Entra tenant with Mail.Send/Mail.Read app access. Empty disables the email step."
  type        = string
}

variable "auth_provider" {
  description = "Frontend identity provider: 'entra' (default) or 'okta'."
  type        = string
  default     = "entra"
}

variable "okta_issuer" {
  description = "Okta OIDC issuer URL (required when auth_provider=okta)."
  type        = string
  default     = ""
}

variable "okta_client_id" {
  description = "Okta OIDC app client id (required when auth_provider=okta)."
  type        = string
  default     = ""
}

variable "okta_redirect_uri" {
  description = "Pinned Okta OIDC callback URL (must end in /login/callback). Strongly recommended when auth_provider=okta: left empty, the frontend derives it from the browser origin, so it changes whenever the CloudFront domain does and login breaks until the new URL is registered on the Okta app. See the okta_redirect_uri_to_register output."
  type        = string
  default     = ""
}

variable "reprocess_cap" {
  description = "Max re-process attempts before a case is aged out."
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------------
# Private-VPC deployment — ONE feature flag.
# ---------------------------------------------------------------------------------
variable "private_vpc" {
  description = <<-EOT
    Deploy fully PRIVATE (no CloudFront, no public endpoints) when true. Flips the frontend to
    an internal ALB on private subnets + Fargate with no public IP, and adds the interface VPC
    endpoints (Bedrock/AgentCore/SSM/ECS/ELB/…) so everything reaches AWS with no NAT/IGW. Reach
    the UI via VPN / Direct Connect / SSM port-forward, and register the internal ALB DNS as an
    OIDC redirect URI. DEFAULT false = the public CloudFront + internet-facing-ALB topology
    (unchanged). This single flag is the whole switch.
  EOT
  type        = bool
  default     = false
}

variable "private_ingress_cidrs" {
  description = "CIDRs allowed to reach the internal ALB when private_vpc=true (VPN/corporate ranges). Empty defaults to the VPC CIDR only. Ignored when private_vpc=false."
  type        = list(string)
  default     = []
}

variable "policy_enforcement_mode" {
  description = "AgentCore Policy mode on the egress tools gateway: LOG_ONLY (evaluate + log, don't block) or ENFORCE (block below-threshold writes). Defaults to ENFORCE — the Cedar confidence gate is the sole threshold enforcement for autonomous writes. Set LOG_ONLY only to temporarily observe without blocking."
  type        = string
  default     = "ENFORCE"
  validation {
    condition     = contains(["LOG_ONLY", "ENFORCE"], var.policy_enforcement_mode)
    error_message = "policy_enforcement_mode must be LOG_ONLY or ENFORCE."
  }
}

variable "agent_backend" {
  description = "Which agent invocation path the agent-worker uses: 'runtime' (container AgentCore Runtime) or 'harness' (managed AgentCore Harness). Instant A/B + rollback."
  type        = string
  default     = "runtime"
  validation {
    condition     = contains(["runtime", "harness"], var.agent_backend)
    error_message = "agent_backend must be 'runtime' or 'harness'."
  }
}

variable "harness_model_id" {
  description = "Bedrock model id / inference profile the managed harness invokes."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "interceptor_mode" {
  description = "Gateway REQUEST interceptor mode: 'log' (observe only) or 'enforce' (block failing provenance/transition checks). Roll out log -> enforce."
  type        = string
  default     = "log"
}

variable "counterparty_email_domains" {
  description = "Domains an analyst may address a counterparty email to. The default empty list allows NOTHING — items under reconciliation come from documents an outside party wrote, so this is the operator's standing answer to 'who is it ever legitimate to write to', and an unset variable must not mean 'anyone'. Consumed by the BFF (inline form feedback + the draft PUT) and enforced by the gateway interceptor."
  type        = list(string)
  default     = []

  validation {
    # Bare, lowercase registrable domains only. The interceptor matches the recipient's domain
    # EXACTLY against these, so an entry carrying an @, a scheme, or capitals silently matches
    # nothing — which would read as "the allowlist is configured" while allowing no send at all.
    condition = alltrue([
      for d in var.counterparty_email_domains :
      d == lower(d) && can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", d))
    ])
    error_message = "Each counterparty_email_domains entry must be a bare lowercase domain (e.g. \"partner.example.com\") — no '@', scheme, or uppercase."
  }
}

variable "enable_worker_tracing" {
  description = "Attach the ADOT layer + OTel env to the agent-worker Lambda so its InvokeHarness/InvokeAgentRuntime calls are traced and share ONE trace with the agent's own spans. false = no layer, no OTel env, PassThrough X-Ray."
  type        = bool
  default     = true
}

variable "otel_layer_version" {
  description = "Version of AWS's public AWSOpenTelemetryDistroPython Lambda layer. Pinned rather than 'latest' (AWS publishes no such alias) so an upstream release can never silently change what runs in the worker."
  type        = number
  default     = 30
}

# AWS's own public publisher account for AWSOpenTelemetryDistroPython. This is NOT a secret and
# NOT one of our accounts — AWS documents this exact ID in its public per-region layer ARN table,
# and there is no public SSM parameter that resolves it. It is nevertheless kept out of the
# committed .tf files because the repo's pre-push guard blocks any 12-digit run, which it cannot
# distinguish from one of our own account IDs.
#
# Deliberately NO default: a wrong or absent value here would otherwise produce a valid-looking
# layer ARN that fails at apply time with an opaque Lambda error. With no default, Terraform stops
# immediately and names the missing variable. The consequence is that `terraform plan` requires a
# local terraform.tfvars (which is gitignored) — see terraform.tfvars.example for the value.
variable "otel_layer_account" {
  description = "AWS's public publisher account ID for the AWSOpenTelemetryDistroPython Lambda layer. Not a secret; see terraform.tfvars.example. Only read when enable_worker_tracing = true."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.otel_layer_account))
    error_message = "otel_layer_account must be a 12-digit AWS account ID."
  }
}
