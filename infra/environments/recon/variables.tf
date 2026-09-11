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

variable "idp_input_bucket" {
  description = "Name of the document pipeline's input bucket, from that stack's outputs. An extraction-routed upload is put here. Empty leaves the upload route reporting it has nowhere to put an extraction file, which is the correct behaviour: the alternative is a put that lands somewhere nothing reads."
  type        = string
  default     = ""
}

variable "idp_input_bucket_arn" {
  description = "ARN of the same bucket. Only the console task role gets a grant, and only three verbs, never on the pipeline's output prefixes: s3:PutObject on the object path for an extraction-routed upload; s3:GetObject on the same path, because the Documents tab streams the source document from here rather than from a copy recon keeps, and the route reads only the key recorded on recon's own notice row; and s3:ListBucket at the bucket level -- not for enumeration (nothing lists this bucket) but because S3 answers a GetObject for an absent key with AccessDenied unless the caller also holds ListBucket, which would make the honest \"the object is no longer in the input bucket\" message unreachable and print a raw IAM denial in the tab instead."
  type        = string
  default     = ""
}

variable "idp_state_machine_arn" {
  description = "ARN of the document pipeline's Step Functions state machine, from that stack's outputs. Recon owns an EventBridge rule on all FOUR of its terminal statuses -- SUCCEEDED, FAILED, TIMED_OUT and ABORTED (see infra/modules/idp-hook/main.tf's event_pattern) -- which is what invokes the ingest hook. The non-success three matter as much as SUCCEEDED: they are what make the hook write the tracking-only row that keeps a failed document VISIBLE in the Documents tab instead of vanishing. Empty creates no rule, so nothing reaches the hook: uploads complete and the notices table stays empty with no error anywhere."
  type        = string
  default     = ""
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

# --- Platform email: notification seed + sending mailbox ---

variable "notify_email" {
  description = <<-EOT
    SEED address for the internal-notification contact, applied once when the contacts table is
    first created. It is not itself the recipient of anything: every send resolves a contact ID
    against that table at the moment it sends, so changing this value on a live deployment has no
    effect and the actual recipient is edited in the Config tab. Empty skips the seed, in which case
    notifications do not send until an operator adds a contact.
  EOT
  type        = string
  default     = ""
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

# Configuration changes — the auto-resolve threshold, the agent backend, the Tier-1 switch, and the list
# of addresses the platform may email — are restricted to members of this OIDC group.
#
# Nothing here creates the group. This deployment has no AWS identity provider, so membership arrives as a
# claim from Okta or Entra and an operator maintains it there. The empty default is deliberate and it
# fails closed: until a group is named, every configuration route answers 403, which is a visible and
# one-variable-fixable state rather than a silently open one.
variable "recon_admin_group" {
  description = "OIDC group whose members may change platform configuration. Empty means nobody can."
  type        = string
  default     = ""
}

variable "auth_groups_claim" {
  description = "JWT claim carrying OIDC group memberships (Okta: groups; Entra: groups or roles)."
  type        = string
  default     = "groups"
}

# Seeds the one extraction workflow type at create time. Empty (the default) seeds only the
# knowledge-base type, and an operator adds extraction types from the Config tab -- which is the
# right shape here, because the configuration version names live in the document-pipeline deployment
# and are not discoverable from this one.
variable "seed_extraction_config_version" {
  description = "IDP configuration version name for the seeded extraction workflow type. Empty skips that seed."
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
    OIDC redirect URI. DEFAULT false selects the public CloudFront + internet-facing-ALB topology
    instead. This single flag is the whole switch.
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

# Defaults to "enforce", not "log". "log" never blocks: it records the decision it would have made
# and forwards the call anyway.
#
# The default matters more than it looks, because the interceptor's provenance, evidence-quality and
# transition guards are the ONLY threshold enforcement in front of an autonomous ledger write —
# there is no second check in app code behind them. A "log" default therefore leaves the write path
# with no gate at all, which is a fail-open default for an enforcement component, wrong for the same
# reason an unset counterparty allowlist means "nobody" rather than "anyone".
#
# Set "log" EXPLICITLY for a first rollout: deploy once, verify the e2e matrix in the interceptor's
# CloudWatch logs, then remove the override. It is a Lambda env-only change, so the flip is cheap
# and there is no reason to leave it in place.
variable "interceptor_mode" {
  description = "Gateway REQUEST interceptor mode: 'enforce' (default — block failing provenance/evidence/transition checks) or 'log' (observe only, never blocks). Set 'log' explicitly for a first rollout, then remove it."
  type        = string
  default     = "enforce"
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

# Maintenance-only lever, deliberately defaulted to the steady state (ENABLED) so a plan run
# without it — CI's `RECON_TFVARS` is a hand copy and will not carry it — never proposes disabling
# scoring by accident. Flip it to false ONLY for the duration of an evaluator update: an ENABLED
# online evaluation config locks the custom analyst-agreement evaluator against update AND delete
# (see infra/modules/agent-evals/main.tf), and disabling the configs is the route AWS documents for
# releasing that lock. While false, sessions get builtin scores but no analyst-agreement score.
variable "online_evals_enabled" {
  description = "Whether the online evaluation configs run. False releases the service-side lock on the custom evaluator so it can be updated; leave true otherwise."
  type        = bool
  default     = true
}

variable "max_concurrent_investigations" {
  description = <<-EOT
    Ceiling on simultaneous Tier-2 agent investigations, applied as reserved concurrency on the
    agent-worker Lambda. This is the Bedrock TPM budget expressed as Lambda concurrency, not a
    performance knob — see the tier1 module variable for the derivation and for both bounds (upper
    ~28 from the token quota, lower 14 from the async queue's 6h retention).
  EOT
  type        = number
  default     = 14
}
