####################################################################################
# Deal-pipeline module: everything the demo needs apart from the Lambda zip.
#
# One S3 bucket (seeded skills, prompts, security master and sample-email corpus; runtime
# emails/CSVs), three DynamoDB tables, two AgentCore Memories (knowledge with an edge-case
# extraction strategy, chat with none), one SSM parameter, and two Python Lambdas (parser, mock
# OMS upload). Contract: docs/deal-pipeline-design.md §2, §3, §8, §11.
#
# There is no ECS, CloudFront, Cognito or gateway here on purpose. The Next.js BFF either runs
# locally with the developer's credentials (infra/environments/deal-pipeline) or is the recon
# console's own container, whose task role the recon root grants access to these resources
# (infra/environments/recon composes this module beside modules/frontend-ecs).
####################################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # abspath() so plan output and S3 object `source` show one unambiguous path instead of a chain
  # of "..", and so the same module works whether the root is invoked from the environment
  # directory or via -chdir.
  content_root = abspath(coalesce(var.content_root, "${path.module}/../../.."))
  skills_dir   = "${local.content_root}/agent-blueprint/deal-pipeline-agent/skills"
  prompts_dir  = "${local.content_root}/agent-blueprint/deal-pipeline-agent/prompts"
  secmaster    = "${local.content_root}/data/security-master"
  samples_dir  = "${local.content_root}/data/deal-emails"

  # "<skill-name>/SKILL.md" relative paths. fileset() returns an empty set when the directory does
  # not exist yet, so a checkout without skills plans cleanly and seeds nothing -- the check block
  # below turns that into a visible warning rather than a silent gap.
  skill_files = fileset(local.skills_dir, "*/SKILL.md")

  # The simulated inbox's corpus, one JSON file per fictional email. The file name (minus .json) is
  # the corpus id the BFF's simulate dialog sends back, so the S3 key keeps the file name verbatim.
  sample_files = fileset(local.samples_dir, "*.json")

  parser_prompt_path    = "${local.prompts_dir}/parser-system.md"
  assistant_prompt_path = "${local.prompts_dir}/assistant-system.md"

  # Memory names must be identifiers (letters, digits, underscore) -- hyphens are rejected.
  memory_name_base = replace(var.name_prefix, "-", "_")

  # The one place the S3 layout (design §3) is spelled out for the parts a Lambda touches. The
  # Lambda env vars and IAM grants below reference these so a prefix rename cannot leave a grant
  # behind. emails/<id>.json is absent on purpose: the BFF alone writes and reads it (the parser
  # takes the email body from the emails table), so no grant here should name it.
  skills_prefix          = "skills/"
  prompts_prefix         = "prompts/"
  security_master_prefix = "security-master/"
  deal_csv_prefix        = "deal-csv/"
  oms_staging_prefix     = "oms-staging/"
  samples_prefix         = "samples/"
  parser_prompt_key      = "${local.prompts_prefix}parser-system.md"
  assistant_prompt_key   = "${local.prompts_prefix}assistant-system.md"
  counterparties_key     = "${local.security_master_prefix}counterparties.csv"

  # Named once so the deals table's GSI and the parser's Query grant on it cannot disagree.
  deals_by_email_index = "by_email"
}

# ---------------------------------------------------------------------------------
# S3 -- seeds + runtime artifacts
# ---------------------------------------------------------------------------------

resource "aws_s3_bucket" "assets" {
  # Account id suffix because bucket names are global; read from the caller identity so it is
  # never committed.
  bucket = "${var.name_prefix}-assets-${local.account_id}"
  # Demo: `terraform destroy` must be able to remove a bucket full of emails and CSVs.
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 rather than KMS, deliberately: with SSE-S3 an object's ETag is still its MD5, which is
# what lets `etag = filemd5(...)` on the seeds below detect a changed file. Under SSE-KMS the ETag
# is opaque and every plan would want to re-upload every seed.
resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Skills are CREATE-ONLY seeds. The demo's whole point is that an approved skill proposal rewrites
# skills/<name>/SKILL.md in S3 (design §1, §12 step 3); if this resource tracked the repo file, the
# next apply -- even one that only changes log retention -- would silently revert the learned
# skill to the committed version. ignore_changes keeps the first upload and leaves every later
# edit to the application.
#
# The list is wider than etag/source because the AWS provider treats a diff in ANY of these
# attributes as a content change and resolves it by re-uploading the whole object from `source`
# -- the repo file -- not with a metadata-only update. Ignoring only etag/source would let an
# application write that merely sets a charset or an x-amz-meta-* tag make the next apply revert
# the learned content. (ignore_changes must be a literal list, so the two seeds repeat it.)
resource "aws_s3_object" "skill_seed" {
  for_each = local.skill_files

  bucket       = aws_s3_bucket.assets.id
  key          = "${local.skills_prefix}${each.value}"
  source       = "${local.skills_dir}/${each.value}"
  etag         = filemd5("${local.skills_dir}/${each.value}")
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source, content_type, metadata, cache_control, content_encoding, storage_class]
  }
}

# Same create-only treatment, same ignore list, for the parser system prompt: the Skills tab edits
# it in place (design §9, /skills/system-prompt PUT). fileexists() -> count keeps the plan valid
# while the prompt is still being written elsewhere in the tree.
resource "aws_s3_object" "parser_prompt_seed" {
  count = fileexists(local.parser_prompt_path) ? 1 : 0

  bucket       = aws_s3_bucket.assets.id
  key          = local.parser_prompt_key
  source       = local.parser_prompt_path
  etag         = filemd5(local.parser_prompt_path)
  content_type = "text/markdown"

  lifecycle {
    ignore_changes = [etag, source, content_type, metadata, cache_control, content_encoding, storage_class]
  }
}

# The assistant prompt has no UI editor, so it TRACKS the repo: a change to the committed file
# re-uploads on the next apply, which is the only way to ship a prompt fix to the chat.
resource "aws_s3_object" "assistant_prompt_seed" {
  count = fileexists(local.assistant_prompt_path) ? 1 : 0

  bucket       = aws_s3_bucket.assets.id
  key          = local.assistant_prompt_key
  source       = local.assistant_prompt_path
  etag         = filemd5(local.assistant_prompt_path)
  content_type = "text/markdown"
}

# Reference data is not editable in the UI either, so it tracks the repo like the assistant
# prompt. Both files are committed, hence no existence guard.
resource "aws_s3_object" "security_master_seed" {
  for_each = toset(["issuers.csv", "counterparties.csv"])

  bucket       = aws_s3_bucket.assets.id
  key          = "${local.security_master_prefix}${each.value}"
  source       = "${local.secmaster}/${each.value}"
  etag         = filemd5("${local.secmaster}/${each.value}")
  content_type = "text/csv"
}

# The sample-email corpus behind the Inbox's "Simulate incoming email" dialog. It lives in S3 so a
# BFF running in a container -- which has no checkout and therefore no data/deal-emails to read --
# can list and fetch the same seven emails a developer's `next dev` reads from disk. Tracks the repo
# like the other reference data: the corpus has no UI editor, so a re-upload on change is the only
# way an edited or added sample reaches a deployment. No existence guard because the corpus is
# committed; a plan against a checkout missing it seeds nothing and the check block below says so.
resource "aws_s3_object" "sample_email_seed" {
  for_each = local.sample_files

  bucket       = aws_s3_bucket.assets.id
  key          = "${local.samples_prefix}${each.value}"
  source       = "${local.samples_dir}/${each.value}"
  etag         = filemd5("${local.samples_dir}/${each.value}")
  content_type = "application/json"
}

# A missing seed is not an error -- the tree is assembled by several hands and the module must
# plan before every file lands -- but it must not be invisible either: a parser with no skills
# and no system prompt "works" and produces garbage. check blocks warn at plan and apply without
# blocking either.
check "seed_content_present" {
  assert {
    condition     = length(local.skill_files) > 0
    error_message = "No */SKILL.md found under ${local.skills_dir}; the parser will run with no skills until they exist and are applied."
  }
  assert {
    condition     = fileexists(local.parser_prompt_path)
    error_message = "${local.parser_prompt_path} is missing; the parser system prompt will not be seeded."
  }
  assert {
    condition     = fileexists(local.assistant_prompt_path)
    error_message = "${local.assistant_prompt_path} is missing; the assistant system prompt will not be seeded."
  }
  assert {
    condition     = length(local.sample_files) > 0
    error_message = "No *.json found under ${local.samples_dir}; a deployed inbox will have nothing to simulate until the corpus exists and is applied."
  }
}

# ---------------------------------------------------------------------------------
# DynamoDB -- pipeline state (design §4)
# ---------------------------------------------------------------------------------

# Point-in-time recovery is OFF on all three: the data is a handful of synthetic demo records that
# a reset re-creates in seconds, and PITR is the one DynamoDB line item that bills while idle.

resource "aws_dynamodb_table" "emails" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a KMS CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  #checkov:skip=CKV_AWS_28:Point-in-time recovery deliberately off for throwaway demo data (see comment above).
  name         = "${var.name_prefix}-emails"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email_id"

  attribute {
    name = "email_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "deals" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a KMS CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  #checkov:skip=CKV_AWS_28:Point-in-time recovery deliberately off for throwaway demo data (see comment above).
  name         = "${var.name_prefix}-deals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "deal_id"

  attribute {
    name = "deal_id"
    type = "S"
  }
  attribute {
    name = "email_id"
    type = "S"
  }

  # Inbox -> deal navigation, and the parser's re-parse lookup: before staging a new deal it
  # queries this index for the email's still-open deals and marks them REJECTED (superseded), so
  # one email never has two live deals. Both without a Scan. ALL projection because the deal list
  # renders fields from the record itself.
  global_secondary_index {
    name            = local.deals_by_email_index
    hash_key        = "email_id"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "skill_proposals" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a KMS CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  #checkov:skip=CKV_AWS_28:Point-in-time recovery deliberately off for throwaway demo data (see comment above).
  name         = "${var.name_prefix}-skill-proposals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "proposal_id"

  attribute {
    name = "proposal_id"
    type = "S"
  }
}

# ---------------------------------------------------------------------------------
# SSM -- runtime-selectable parser model (Config tab writes it, parser reads it per run)
# ---------------------------------------------------------------------------------

resource "aws_ssm_parameter" "agent_model_id" {
  name  = "/${var.name_prefix}/agent-model-id"
  type  = "String"
  value = var.agent_model_id

  lifecycle {
    ignore_changes = [value] # Selected at runtime from the Config tab, never by Terraform.
  }
}
