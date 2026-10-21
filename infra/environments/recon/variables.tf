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

# ---------------------------------------------------------------------------------
# WHICH IDENTITY PROVIDER THE CONSOLE SIGNS IN AGAINST.
#
# "cognito" is the DEFAULT, and that is the point of it: an Amazon Cognito user pool is created by
# this stack (modules/console-auth), so the sample is deployable and demonstrable by anyone with an
# AWS account and no external IdP tenant at all. Okta and Entra remain first-class -- naming either
# one here skips the pool entirely and nothing else about those deployments changes.
#
# Choosing "cognito" is not a step down from federating an enterprise directory, it is the step
# BEFORE it: add a SAML or OIDC provider to the pool (aws_cognito_identity_provider) and name it in
# cognito_supported_identity_providers, and the enterprise directory becomes an upstream of the pool
# while the console keeps validating exactly ONE issuer. Pointing the console straight at the
# enterprise IdP -- what "okta" and "entra" do -- is the arrangement that needs a tenant before
# anything works at all.
# ---------------------------------------------------------------------------------

variable "auth_provider" {
  description = "Console identity provider: 'cognito' (default — a user pool this stack creates), 'okta' or 'entra'."
  type        = string
  default     = "cognito"

  validation {
    # A typo used to fall through to the Entra branch of local.oidc_issuer and surface as an intake
    # variable-validation failure about a blank issuer, which named the wrong thing. Named here.
    condition     = contains(["cognito", "okta", "entra"], var.auth_provider)
    error_message = "auth_provider must be 'cognito', 'okta' or 'entra'."
  }
}

# Globally unique across every AWS account, so it cannot be defaulted: a prefix derived from
# name_prefix would collide with the next person who deploys this sample and the collision arrives
# mid-apply. Deliberately NOT given a default at all rather than a generated one -- Terraform stops
# and names this variable, which beats an InvalidParameterException twenty minutes into an apply.
variable "cognito_hosted_ui_prefix" {
  description = "Globally unique hosted-UI domain prefix for the console's user pool; the sign-in host becomes <prefix>.auth.<region>.amazoncognito.com. REQUIRED when auth_provider = cognito, ignored otherwise. Lowercase letters, digits and hyphens, and it may not contain \"aws\", \"amazon\" or \"cognito\" (Cognito reserves those). Add some entropy — e.g. \"recon-dev-login-7f3a\"."
  type        = string
  default     = ""

  validation {
    # Cross-variable validation (Terraform >= 1.9): only required for the provider that needs it, so
    # an Okta or Entra deployment never has to name a login domain it does not have.
    condition     = var.auth_provider != "cognito" || trimspace(var.cognito_hosted_ui_prefix) != ""
    error_message = "auth_provider = \"cognito\" requires cognito_hosted_ui_prefix: the hosted-UI domain is globally unique across all AWS accounts, so it cannot be defaulted from name_prefix without colliding with another deployment of this sample."
  }
}

variable "cognito_redirect_uri" {
  description = "Pinned OAuth callback URL for the Cognito flow. Must end in /callback. Empty (the default) lets the browser derive it from its own origin, which is correct for a single-host deployment because this stack registers that origin's callback itself. Pin it when the console is reachable on more than one host (a custom domain as well as the CloudFront domain), since Cognito redirects only to a registered URL and the browser sends whichever origin it is on."
  type        = string
  default     = ""
}

# Localhost is registered on the app client BY DEFAULT, and that is a deliberate trade for a sample
# whose documented workflow is `npm run dev` against a real deployment (see the frontend_env_local
# output). Cognito permits plain http only for localhost, and a redirect to a loopback address cannot
# be reached by anyone who is not already on the machine -- so the exposure is a browser on the
# operator's own laptop, not a third party. Set false for a deployment where nobody should be able to
# complete a sign-in outside the console's own host.
variable "cognito_local_dev_callbacks" {
  description = "Also register http://localhost:<port>/callback and http://localhost:<port> on the app client, so `npm run dev` can sign in against this deployment's pool. True by default; set false to allow sign-in only from the console's deployed host."
  type        = bool
  default     = true
}

variable "cognito_local_dev_port" {
  description = "Port the local `next dev` server listens on, for the localhost callback URLs above. Cognito matches the URL exactly, so this has to be the port actually used."
  type        = number
  default     = 3000
}

variable "cognito_extra_callback_urls" {
  description = "Further OAuth callback URLs to register on the app client — a custom domain's /callback, a second environment's host. Each must be the FULL URL the browser sends; Cognito compares exactly. https only (except localhost, which cognito_local_dev_callbacks handles)."
  type        = list(string)
  default     = []
}

variable "cognito_extra_logout_urls" {
  description = "Further sign-out redirect URLs. The console signs out to its own ORIGIN with no trailing slash, so entries here should be bare origins (\"https://console.example.com\"), not paths."
  type        = list(string)
  default     = []
}

variable "cognito_mfa_configuration" {
  description = "Pool MFA: \"OPTIONAL\" (default — TOTP offered, skippable), \"ON\" (TOTP required for everyone, enrolled before the console is reachable) or \"OFF\". SMS is not offered in any mode. Set \"ON\" for a deployment handling anything real."
  type        = string
  default     = "OPTIONAL"
}

variable "cognito_deletion_protection" {
  description = "\"INACTIVE\" (default) so `terraform destroy` can tear this sample down again. \"ACTIVE\" for a deployment whose user list matters: recreating the pool changes the token issuer and every `sub`, so the audit trail's author ids stop resolving."
  type        = string
  default     = "INACTIVE"
}

variable "cognito_supported_identity_providers" {
  description = "Identity providers the app client offers. [\"COGNITO\"] (the default) is the pool's own directory. TO FEDERATE an enterprise IdP: add an aws_cognito_identity_provider to the pool and ADD its name here — the provider resource alone does not make the hosted UI offer it, and dropping \"COGNITO\" from this list disables local pool users entirely."
  type        = list(string)
  default     = ["COGNITO"]
}

# ---------------------------------------------------------------------------------
# The out-of-band callback patch.
#
# Cognito matches a callback URL EXACTLY, so the real one has to name the console's public host --
# and that host (the CloudFront domain) does not exist until the frontend tier is created, while the
# frontend tier needs the app client's ID as a BUILD ARGUMENT. Neither can be created after the
# other, so the client is created with the URLs it can know and this patch adds the deployed host's
# in the same apply, through the deploy-actions actor. The lifecycle ignore on the client
# (modules/console-auth) exists only because of this patch, and the two must be deleted together.
#
# The patch runs the `patch_cognito_callbacks` action in infra/modules/deploy-actions/src/handler.py.
# Turning this OFF is a supported way to keep the deploy-time actor out of Cognito entirely: sign-in
# then works only from the URLs the client was CREATED with (localhost, plus anything pinned or listed
# above), and the deployed host's callback has to be registered by hand -- the post_deploy_checklist
# output prints the two URLs to add. Until they are added, sign-in from the CloudFront domain fails
# with `redirect_mismatch`.
# ---------------------------------------------------------------------------------
variable "enable_cognito_callback_patch" {
  description = "Register this deployment's CloudFront (or internal ALB) callback and sign-out URLs on the Cognito app client at the end of the apply, through the deploy-actions actor. True by default. Set false to keep that actor out of Cognito and register the two URLs post_deploy_checklist prints by hand instead."
  type        = bool
  default     = true
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
# WHO CREATES THE GROUP depends on auth_provider, and the empty default means different things:
#   * okta / entra: nothing here can create it. Membership arrives as a claim from a tenant Terraform
#     cannot see, and an operator maintains it there. Empty therefore fails CLOSED -- until a group is
#     named, every configuration route answers 403, a visible and one-variable-fixable state rather
#     than a silently open one.
#   * cognito: modules/console-auth creates this group IN the pool, so empty means "use the pool's own
#     name for it" (local.console_groups in main.tf resolves it, and the same string is what the
#     console checks). It still fails closed in the way that matters: the group is created EMPTY, so
#     nobody administers anything until an operator adds a user to it.
# Set it explicitly to override the pool's name, or to name an existing group in an external IdP.
variable "recon_admin_group" {
  description = "OIDC group whose members may change platform configuration. Empty means nobody can."
  type        = string
  default     = ""
}

# ⚠️ The DEFAULT IS BLANK, meaning "the right claim for the selected provider", and that is
# load-bearing rather than tidy. Cognito puts group memberships in `cognito:groups` -- a RESERVED claim
# name the service will not let you rename -- while Okta and Entra release `groups`. A literal "groups"
# default would therefore have been silently wrong for the new default provider in the worst possible
# way: every token would parse, every group list would come back EMPTY, and every user would be denied
# every app and every admin route with nothing anywhere saying why.
#
# local.auth_groups_claim in main.tf resolves blank to "cognito:groups" or "groups" per provider, so an
# Okta or Entra deployment renders exactly the value it rendered before this variable had a blank
# default. Set it explicitly to override -- which is what a FEDERATED pool needs, because a SAML or OIDC
# provider mapped into the pool commonly lands its group attribute on a custom claim (`custom:groups`)
# rather than on `cognito:groups`.
variable "auth_groups_claim" {
  description = "JWT claim carrying group memberships. Blank (the default) resolves per provider: `cognito:groups` for Cognito, `groups` for Okta and Entra. Set it explicitly for an Entra app that releases `roles`, or for a federated Cognito pool that maps groups onto a custom claim."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------------
# Two apps behind one app rail: per-app ACCESS groups, and the pipeline's ADMIN group.
#
# The console hosts the reconciliation app and the deal-pipeline app side by side, and the proxy
# decides per request whether the caller may use the app the route belongs to. Same source of truth
# as recon_admin_group: an OIDC group claim, maintained in Okta or Entra, never created here.
#   * ADMIN groups default to "" = NOBODY, the fail-closed reading recon_admin_group already has.
#   * ACCESS groups default to "" = OPEN to every authenticated user -- but only while this root
#     deploys the recon app ALONE (enable_deal_pipeline = false). That is what every deployment had
#     before the rail existed, so a recon-only upgrade changes nobody's access.
#   * With enable_deal_pipeline = true BOTH access groups are required: the validation on that
#     variable refuses a blank one at plan, and the console runs with REQUIRE_ACCESS_GROUPS=true so
#     a blank group fails CLOSED at runtime as well. "Every authenticated user" stops meaning "every
#     recon analyst" the moment a second population signs in through the same OIDC client, and
#     several recon write routes (system prompt, skills, harness configs, evals, case status) are
#     gated by the access check alone, so the deal desk must not inherit them by default.
# Admins implicitly have access, so an administrator never needs to be in both groups.
#
# ⚠️ With auth_provider = "cognito" every "" above resolves to the pool's own group name instead
# (local.console_groups in main.tf), because modules/console-auth actually CREATES these five groups
# and the console must check the names that exist. That makes a Cognito access group non-blank, so it
# is closed rather than open by default -- the group is created empty and an operator adds people to
# it. It is also why the enable_deal_pipeline validation below accepts a blank pair under Cognito:
# there is nothing left to fail closed about.
# ---------------------------------------------------------------------------------

variable "recon_access_group" {
  description = "OIDC group whose members may use the reconciliation app. Empty (the default) leaves it open to every authenticated user in a recon-only deployment; REQUIRED (non-blank) when enable_deal_pipeline is true."
  type        = string
  default     = ""
}

variable "pipeline_access_group" {
  description = "OIDC group whose members may use the deal-pipeline app. REQUIRED (non-blank) when enable_deal_pipeline is true; ignored when it is false."
  type        = string
  default     = ""
}

variable "pipeline_admin_group" {
  description = "OIDC group whose members may approve deals, edit skills and the parser prompt, decide skill proposals, manage memory and change the pipeline's model. Empty means nobody can."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------------
# Console-wide settings: the layer ABOVE the two apps (infra/modules/console-settings; the contract
# is chatbot-app/frontend/src/lib/console/types.ts).
#
# Every group variable above is ALSO seeded into SSM under /<name_prefix>/console, where members of
# console_admin_group can change it from the console's Settings screen without a redeploy. A stored
# value outranks the environment (stored -> env -> default), and Terraform never reverts one: the
# module ignores value changes after creation. Who may use that screen is the one thing that stays
# environment-only, so a UI edit can never make someone a console admin.
# ---------------------------------------------------------------------------------

variable "console_admin_group" {
  description = "OIDC group whose members may edit console-wide settings (access groups, app enablement, defaults) from the console's Settings screen. Environment-only: nothing stored can grant it. Empty (the default) FAILS CLOSED: nobody can edit console settings until it is set, and the screens render read-only."
  type        = string
  default     = ""
}

variable "console_organization_label" {
  description = "Label shown under the console mark in the app rail, and the seed for the stored organization-label setting an operator may change in the Settings screen afterwards."
  type        = string
  default     = "Agentic Operations Console"
}

# ---------------------------------------------------------------------------------
# Deal-pipeline app, composed into this root from infra/modules/deal-pipeline.
# ---------------------------------------------------------------------------------

variable "enable_deal_pipeline" {
  description = <<-EOT
    Deploy the deal-pipeline app beside the recon platform: its bucket, three tables, two AgentCore
    Memories, SSM parameter and two Lambdas (under the "<name_prefix>-pipeline" prefix), plus the
    console's environment and task-role grants for it. false (the default) leaves an existing recon
    deployment exactly as it was: the console is told PIPELINE_ENABLED=false, so the rail shows only
    the reconciliation app and /api/pipeline/* is refused. true REQUIRES recon_access_group and
    pipeline_access_group to be set.
  EOT
  type        = bool
  default     = false

  validation {
    # Cross-variable validation (Terraform >= 1.9). Refused at PLAN, naming the variables the operator
    # sets, rather than deploying a console in which the whole deal desk passes recon's access check.
    # trimspace() because a whitespace-only group is what the console treats as blank.
    #
    # auth_provider == "cognito" is exempt because the premise no longer holds: modules/console-auth
    # creates both access groups and local.console_groups hands the console those very names, so a
    # blank variable there does not mean "open to everyone", it means "use the group the pool made".
    # Setting either variable explicitly under Cognito still works and still wins.
    condition     = !var.enable_deal_pipeline || var.auth_provider == "cognito" || (trimspace(var.recon_access_group) != "" && trimspace(var.pipeline_access_group) != "")
    error_message = "enable_deal_pipeline = true requires both recon_access_group and pipeline_access_group to be set (non-blank) when auth_provider is 'okta' or 'entra'. With two apps behind one external OIDC client and nothing here able to create a group, a blank access group would admit every deal-desk user to the recon app (and every recon analyst to the pipeline), including recon's access-gated write routes. Name both groups, set enable_deal_pipeline = false, or use auth_provider = 'cognito', where the pool creates both groups and the console checks their names."
  }
}

variable "pipeline_agent_model_id" {
  description = <<-EOT
    Bedrock model (or cross-region inference-profile) id for BOTH the pipeline's parsing agent and
    its assistant. For the parser it only SEEDS the /<name_prefix>-pipeline/agent-model-id SSM
    parameter, which the pipeline's Config tab overwrites at runtime; for the assistant it is the
    model the BFF invokes directly (ASSISTANT_MODEL_ID), with no runtime override.
  EOT
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "pipeline_memory_model_id" {
  description = "Bedrock model (or inference-profile) id the pipeline's AgentCore Memory uses for its edge-case extraction pass. Pinned separately from pipeline_agent_model_id so a Config-tab model switch cannot change how memories are extracted."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "enable_pipeline_seed_push" {
  description = <<-EOT
    Run the deploy-actions seed reconciliation (aws_lambda_invocation.pipeline_seed_push) against the
    pipeline's create-only seeds -- its skills and parser prompt -- on every apply, the way recon's
    seed_push does for recon's. Only meaningful with enable_deal_pipeline = true; ignored otherwise.

    false (the default) on purpose: the reconciliation's FIRST run against a pipeline whose skill or
    prompt objects were edited live before the push existed fails the apply as AMBIGUOUS (no marker
    yet, and the live ETag differs from the repo MD5) -- after the module moves and the policy update
    in the same apply have landed, which is not where an auto-applying CI should stop. Adopt those
    keys first, by hand: `terraform output -raw pipeline_seed_push_command` prints the exact
    infra/scripts/push_editable_seeds.py run for this deployment's bucket and keys; re-run it until it
    exits 0, then set this true. A fresh deployment can set it true from the start, because a
    just-created object is the "record" branch and cannot be ambiguous.
  EOT
  type        = bool
  default     = false
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
# TIER FLAGS — the cheap development profile.
#
# All five default to `true`, so an existing tfvars deploys exactly what it deploys today and no
# operator has to learn about them to keep working. Turning them off lets a developer apply the parts
# of this platform they need to exercise the two console apps against REAL AWS from a laptop, without
# the parts that either cost money every hour or add half an hour to a first apply.
#
# ⚠️ These are COARSE on purpose. Each one is drawn where no reference dangles: every module they gate
# is consumed either through an input the consumer already documents as optional ("" or [] disables
# the feature) or through nothing at all. A finer flag -- one that gated the knowledge base inside
# modules/recon-agent, say -- would have to thread a count through a dozen references, a Cedar policy
# string and a gateway target in the maintainer's largest module. What is and is not gated is spelled
# out on each variable.
#
# WHAT A MINIMAL APPLY (all five false) STILL CREATES, because a developer needs it to exercise the
# apps: the Cognito pool, the DynamoDB tables and S3 buckets, the SSM parameter layers, the shared
# Lambda zip and every Lambda that runs from it, the intake HTTP API, the deal-pipeline app's own
# resources when enable_deal_pipeline is set, AND the recon agent tier -- the AgentCore Runtime
# container (a CodeBuild image build, so still not a fast first apply), the managed harness, the tools
# gateway with its targets, and Tier-1/Tier-2. The agent is what turns an intaken item into a case, so
# a console with no agent has an empty queue; it is deliberately not behind a flag.
# ---------------------------------------------------------------------------------

variable "enable_private_networking" {
  description = <<-EOT
    Create the private networking tier (modules/network): two private subnets, a NAT gateway with its
    Elastic IP, the S3/DynamoDB gateway endpoints and -- with private_vpc -- the interface endpoints.

    true (the default) is what every existing deployment has. false removes the standing NAT gateway
    charge, which is the single largest always-on cost in this stack after the frontend tier, and every
    VPC-attached Lambda plus the AgentCore Runtime then runs UNATTACHED: `vpc_subnet_ids = []`, which
    each module already documents as "no VPC". They reach AWS over the Lambda service network instead
    of through a NAT, so they still work -- they simply are not inside your VPC, and no in-VPC-only
    resource is reachable from them. Requires private_vpc = false (validated there).
  EOT
  type        = bool
  default     = true
}

variable "enable_frontend_tier" {
  description = <<-EOT
    Create the console's serving tier (modules/frontend-ecs): the CodeBuild image build, ECR
    repository, ECS cluster and Fargate service, the ALB, CloudFront and its WAF web ACL.

    true (the default) is what every existing deployment has. false skips ALL of it -- the running
    Fargate task, the load balancer, the distribution and the web ACL are the hourly costs, and the
    container build is most of a first apply's wall clock. Nothing else in this root depends on the
    frontend tier's resources (the recon agent's Cedar principal names its task role by CONVENTION,
    not by reference, so that rule simply never matches while the tier is absent).

    The console then runs on the laptop instead: `terraform output -raw frontend_env_local` still
    renders a complete .env.local for `npm run dev`, composed from this root's own values rather than
    read back from a task definition that does not exist. The Cognito callback patch is skipped too --
    there is no CloudFront domain to register -- so sign-in works from the localhost URLs the app
    client was created with.
  EOT
  type        = bool
  default     = true
}

variable "enable_knowledge_base_corpus" {
  description = <<-EOT
    Upload the sample knowledge-base corpus and INGEST it: the aws_s3_object.kb_seed tree, the
    blocking aws_lambda_invocation.kb_ingestion that polls a Bedrock ingestion job to completion, and
    modules/kb-ingest-trigger (the Lambda that ingests each later KB-routed upload).

    true (the default) is what every existing deployment has. false leaves the knowledge base EMPTY:
    the ingestion poll is what dominates a first apply after the two container builds, and indexed
    storage is what a managed KB charges for. consult-guidance then retrieves nothing -- with no error
    anywhere, which is why post_deploy_checklist says so out loud.

    ⚠️ SCOPE: this does NOT remove the knowledge base itself. aws_bedrockagent_knowledge_base.managed,
    its data source, its `managed-kb` gateway target and the Cedar rule permitting Retrieve live inside
    modules/recon-agent, where the gateway's tool policy, the connector target and the readiness wait
    all reference them; gating those would need a count and a `moved` block on each, in the module this
    root depends on most. An un-ingested managed KB is charged on the data it indexes, so an empty one
    is the cheap state -- what this flag removes is the corpus, the job and the upload trigger.
  EOT
  type        = bool
  default     = true
}

variable "enable_agent_evals" {
  description = <<-EOT
    Create modules/agent-evals: the custom analyst-agreement evaluator Lambda and the two online
    evaluation configs that score every agent session.

    true (the default) is what every existing deployment has. false skips them, which removes a
    RECURRING MODEL SPEND rather than an hourly resource charge -- an online eval config invokes judge
    models on each session, so scoring costs tokens for as long as the platform runs. The Evals tab
    then has no results to show and the batch route has no evaluator to map 'analyst_agreement' to; the
    console reads the three inputs as empty, which each of them already documents as "disabled".
    online_evals_enabled is ignored when this is false (there are no configs to disable).
  EOT
  type        = bool
  default     = true
}

variable "enable_observability" {
  description = <<-EOT
    Create modules/observability: the AgentCore Runtime's OTEL log delivery to CloudWatch and its
    trace delivery to X-Ray.

    true (the default) is what every existing deployment has. false skips both. Nothing in this root
    reads its outputs, so this is the cleanest of the five to turn off -- but it is also the one that
    costs you the most insight: the agent's spans stop reaching CloudWatch, so the Evals tab cannot
    score RUNTIME-backend sessions (the eval service reads content only from delivered log groups) and
    a failed investigation has no trace to read. Turn it off for a data-plane-only apply, not to save
    money on a deployment anyone is watching.
  EOT
  type        = bool
  default     = true
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

  validation {
    # A private deployment IS the private networking tier: without it there are no private subnets to
    # put the ALB and the task on, and no execute-api interface endpoint for the private intake REST
    # API to be locked to. modules/intake already refuses a blank endpoint id, but it refuses it from
    # inside a module, naming an input rather than the two variables an operator actually set.
    condition     = !var.private_vpc || var.enable_private_networking
    error_message = "private_vpc = true requires enable_private_networking = true: the internal ALB, the Fargate task and the private intake REST API all need the network module's private subnets and its execute-api interface endpoint. Enable the networking tier, or deploy the public topology."
  }
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
