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

# The group whose members may change platform configuration — the auto-resolve threshold, the agent
# backend, the Tier-1 switch, and the list of addresses the platform may email.
#
# Terraform cannot create this group: there is no Cognito user pool in this deployment, so membership
# comes from the identity provider's group claim and an operator adds people to it in Okta or Entra. The
# empty default therefore means "nobody yet", which is the safe reading — the routes refuse every caller
# until the group is named here.
variable "recon_admin_group" {
  description = "OIDC group whose members may change platform configuration. Empty means nobody can."
  type        = string
  default     = ""
}

# Which claim carries group memberships. Okta releases them as `groups` when the app is configured to;
# Entra uses `groups` or `roles` depending on the app registration. Wrong name means an empty group list,
# which reads as "not an admin" rather than as a misconfiguration — so if the Config tab is missing for
# someone who should have it, check this before checking the group name.
variable "auth_groups_claim" {
  description = "JWT claim carrying OIDC group memberships (Okta: groups; Entra: groups or roles)."
  type        = string
  default     = "groups"
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

# --- Contacts + email templates (Config tab CRUD; recipient resolution on send) ---

variable "contacts_table" {
  description = "Contacts table name. The BFF reads it to resolve an approved draft's recipient_contact_id to an address at send time, and writes it from the Config tab. There is no configured recipient address anywhere in this module -- storing one would survive an operator deactivating the contact."
  type        = string
  default     = ""
}

variable "contacts_table_arn" {
  description = "ARN of the contacts table, for the task role's read+write grant."
  type        = string
  default     = ""
}

variable "templates_table" {
  description = "Email-templates table name. The BFF renders an approved draft from the stored template and writes the table from the Config tab."
  type        = string
  default     = ""
}

variable "templates_table_arn" {
  description = "ARN of the email-templates table, for the task role's read+write grant."
  type        = string
  default     = ""
}

variable "workflow_types_table" {
  description = "Workflow-types table name. The Config tab reads and writes it; nothing else does. Empty disables the panel rather than pointing it at a table named \"\"."
  type        = string
  default     = ""
}

variable "workflow_types_table_arn" {
  description = "ARN of the workflow-types table, for the task role's read+write grant."
  type        = string
  default     = ""
}

variable "uploads_table" {
  description = "Name of the upload-submissions table the upload route writes and the Documents tab reads."
  type        = string
  default     = ""
}

variable "uploads_table_arn" {
  description = "ARN of the same table."
  type        = string
  default     = ""
}

variable "uploads_table_index_arn" {
  description = "ARN of its by_recency index. A Query on an index needs its OWN ARN in the grant; the table ARN alone answers AccessDenied and the Recent uploads table renders an error instead of rows."
  type        = string
  default     = ""
}

variable "notices_table" {
  description = "Name of the notices table. The Documents tab reads the per-section extraction the post-processing hook embedded on each notice row -- see the read-only grant in main.tf for why nothing here may write to it."
  type        = string
  default     = ""
}

variable "notices_table_arn" {
  description = "ARN of the same table. No index ARN: the tab reads by notice id (GetItem/BatchGetItem) and never queries an index."
  type        = string
  default     = ""
}

variable "idp_input_bucket" {
  description = "The document pipeline's input bucket. An extraction-routed upload is put here."
  type        = string
  default     = ""
}

variable "idp_input_bucket_arn" {
  description = "ARN of the same bucket, for the object-path PutObject grant."
  type        = string
  default     = ""
}

variable "email_preprocess_function_name" {
  description = "Name of the pre-processor the upload route invokes for a .msg or .eml."
  type        = string
  default     = ""
}

variable "email_preprocess_function_arn" {
  description = "ARN of the same function, for the scoped lambda:InvokeFunction grant."
  type        = string
  default     = ""
}

variable "idp_appsync_endpoint" {
  description = "HTTPS GraphQL endpoint of the document pipeline's AppSync API, from that stack's outputs. The Documents tab reads it server-side as the task role. Empty leaves the tab reporting that it is not configured, which is the honest outcome -- a defaulted endpoint would sign a request to nowhere and read like the pipeline being down."
  type        = string
  default     = ""
}

variable "idp_appsync_api_arn" {
  description = "ARN of that same AppSync API (arn:aws:appsync:REGION:ACCOUNT:apis/API_ID), used to build the field-scoped read grant below. Empty grants nothing."
  type        = string
  default     = ""
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

variable "agent_model_id_param" {
  description = "SSM parameter name of the live Tier-2 model selection, read and written by the Config tab."
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

variable "intake_function_name" {
  description = "Intake Lambda name the BFF invokes for manual payload submission ('' disables the queue's Create New action)."
  type        = string
  default     = ""
}

variable "intake_function_arn" {
  description = "Intake Lambda ARN, for the scoped lambda:InvokeFunction grant."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------------
# Per-app access (src/lib/auth/apps.ts). One console, two apps behind an app rail.
#
# Each app has an ACCESS group ("may use it") and an ADMIN group ("may change its configuration and
# approve"); admins implicitly have access. Both are OIDC group claims, like recon_admin_group above:
# nothing here creates a group. The two kinds of group fail in OPPOSITE directions on purpose --
#   * an unset ACCESS group leaves the app open to every authenticated user, which is exactly what
#     every deployment had before the rail existed, so adding the rail changes nobody's access;
#   * an unset ADMIN group means nobody administers the app, the same fail-closed reading
#     recon_admin_group has always had.
# ---------------------------------------------------------------------------------

variable "recon_access_group" {
  description = "OIDC group whose members may use the reconciliation app. Empty (the default) leaves it open to every authenticated user; recon_admin_group members have access regardless."
  type        = string
  default     = ""
}

variable "pipeline_access_group" {
  description = "OIDC group whose members may use the deal-pipeline app. Empty (the default) leaves it open to every authenticated user; pipeline_admin_group members have access regardless."
  type        = string
  default     = ""
}

variable "pipeline_admin_group" {
  description = "OIDC group whose members may approve deals, edit skills and the parser prompt, decide skill proposals, manage memory and change the pipeline's model. Empty means nobody can."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------------
# Deal-pipeline app wiring (modules/deal-pipeline), all optional.
#
# Every value defaults so a caller that deploys the recon console alone is unchanged. When
# pipeline_enabled is true the task gets the PIPELINE_*/EMAILS_TABLE/... environment and the task
# role gets grants on exactly these resources; a precondition on the policy insists every ARN is
# set, because an empty Resource list is a malformed policy and a "" table name is a request to a
# table that cannot exist.
#
# Three names are PIPELINE_-prefixed in the container (PIPELINE_ASSETS_BUCKET,
# PIPELINE_AGENT_MODEL_PARAM, PIPELINE_SKILLS_PREFIX) because the recon BFF already reads
# ASSETS_BUCKET, AGENT_MODEL_PARAM and SKILLS_PREFIX for ITS bucket, parameter and prefix, and one
# process cannot hold two values under one name. The pipeline BFF reads the prefixed name first and
# falls back to the bare one, so the standalone root's .env.local keeps working either way.
# ---------------------------------------------------------------------------------

variable "pipeline_enabled" {
  description = "Deploy the deal-pipeline app inside this console: its environment variables and task-role grants. false (the default) is the recon-only console."
  type        = bool
  default     = false
}

variable "pipeline_assets_bucket" {
  description = "The deal pipeline's S3 bucket (skills, prompts, security master, sample corpus, emails, staging CSVs). Rendered as PIPELINE_ASSETS_BUCKET."
  type        = string
  default     = ""
}

variable "pipeline_assets_bucket_arn" {
  description = "ARN of the same bucket, for the prefix-scoped object grants and the ListBucket condition."
  type        = string
  default     = ""
}

variable "pipeline_emails_table" {
  description = "Deal-pipeline emails table name (EMAILS_TABLE)."
  type        = string
  default     = ""
}

variable "pipeline_emails_table_arn" {
  type    = string
  default = ""
}

variable "pipeline_deals_table" {
  description = "Deal-pipeline deals table name (DEALS_TABLE). The grant also covers its indexes: the inbox reads deals by email through the by_email GSI."
  type        = string
  default     = ""
}

variable "pipeline_deals_table_arn" {
  type    = string
  default = ""
}

variable "pipeline_skill_proposals_table" {
  description = "Deal-pipeline skill-proposals table name (SKILL_PROPOSALS_TABLE)."
  type        = string
  default     = ""
}

variable "pipeline_skill_proposals_table_arn" {
  type    = string
  default = ""
}

variable "pipeline_knowledge_memory_id" {
  description = "AgentCore Memory holding the edge_cases strategy: the assistant's save_memory writes it, the Memory Manager lists and deletes its records (KNOWLEDGE_MEMORY_ID)."
  type        = string
  default     = ""
}

variable "pipeline_knowledge_memory_arn" {
  type    = string
  default = ""
}

variable "pipeline_chat_memory_id" {
  description = "AgentCore Memory the assistant writes chat turns to and rebuilds history from (CHAT_MEMORY_ID)."
  type        = string
  default     = ""
}

variable "pipeline_chat_memory_arn" {
  type    = string
  default = ""
}

variable "pipeline_parser_function_name" {
  description = "Parsing-agent Lambda the BFF async-invokes on intake and reparse (PARSER_FUNCTION)."
  type        = string
  default     = ""
}

variable "pipeline_parser_function_arn" {
  type    = string
  default = ""
}

variable "pipeline_oms_upload_function_name" {
  description = "Mock OMS validator Lambda the BFF invokes synchronously on approve (OMS_UPLOAD_FUNCTION)."
  type        = string
  default     = ""
}

variable "pipeline_oms_upload_function_arn" {
  type    = string
  default = ""
}

variable "pipeline_agent_model_param" {
  description = "SSM parameter name holding the runtime-selected parser model; the Config tab reads and writes it (PIPELINE_AGENT_MODEL_PARAM)."
  type        = string
  default     = ""
}

variable "pipeline_agent_model_param_arn" {
  description = "ARN of the same parameter. Enumerated rather than path-scoped, unlike the recon parameters: it lives under the pipeline's own prefix, and a wildcard there would hand this role every parameter added under it later."
  type        = string
  default     = ""
}

variable "pipeline_assistant_model_id" {
  description = "Bedrock model (or inference-profile) id the assistant chat invokes directly (ASSISTANT_MODEL_ID)."
  type        = string
  default     = ""
}

variable "pipeline_samples_prefix" {
  description = "S3 prefix of the seeded sample-email corpus the simulate dialog lists (PIPELINE_SAMPLES_PREFIX). The container has no checkout, so unlike local dev there is no SAMPLE_EMAILS_DIR fallback."
  type        = string
  default     = "samples/"
}

variable "pipeline_skills_prefix" {
  description = "S3 prefix of the pipeline's editable skills (PIPELINE_SKILLS_PREFIX); also the prefix the task role may read, write and list."
  type        = string
  default     = "skills/"
}

variable "pipeline_parser_prompt_key" {
  description = "S3 key of the parser system prompt the Skills tab edits in place (PARSER_PROMPT_KEY)."
  type        = string
  default     = "prompts/parser-system.md"
}
