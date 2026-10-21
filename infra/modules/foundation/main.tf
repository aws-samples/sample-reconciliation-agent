####################################################################################
# Foundation module: S3 buckets, recon-flow DynamoDB tables and the SSM configuration parameters.
#
# No identity provider lives here, and that is deliberate rather than incidental. This module once owned
# a Cognito user pool that nothing ever signed in to — it existed only to issue tokens for the intake
# API while the console signed in through Okta — and it was rightly deleted. The console's pool is back,
# as the console's ACTUAL login, but it lives in modules/console-auth: this module is S3 + DynamoDB +
# SSM, and the identity provider (whichever `auth_provider` selects) is somebody else's resource.
# Classification types are NOT stored here — they live in the SKILL.md files. DynamoDB
# holds only recon-flow state: items, cases, and the audit trail.
####################################################################################

# ---------------------------------------------------------------------------------
# DynamoDB — recon-flow state only (no class-registry table)
# ---------------------------------------------------------------------------------

resource "aws_dynamodb_table" "items" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "item_id"

  attribute {
    name = "item_id"
    type = "S"
  }

  # Stream feeds the Tier-1 consumer, which is how an intaken item becomes a case.
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  # Point-in-time recovery: cheap continuous backup, no functional impact.
  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "cases" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-cases"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "item_id"

  attribute {
    name = "item_id"
    type = "S"
  }
  attribute {
    name = "status"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "S"
  }

  # Lets the BFF query open cases by status without a full-table Scan.
  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "audit" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "item_id"
  range_key    = "ts"

  attribute {
    name = "item_id"
    type = "S"
  }
  attribute {
    name = "ts"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Lessons-learned ledger: captured analyst decisions/corrections. GSI by domain for
# the UI tab + agent retrieval.
resource "aws_dynamodb_table" "lessons" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-lessons"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "lesson_id"

  attribute {
    name = "lesson_id"
    type = "S"
  }
  attribute {
    name = "domain"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "domain-index"
    hash_key        = "domain"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---------------------------------------------------------------------------------
# Runtime config — SSM parameters the Config tab writes and the runtime reads.
#
# Every parameter here is seeded with a starting value and then carries
# `ignore_changes = [value]`: the UI is the owner at runtime, so an apply must create the parameter
# but never revert an operator's setting.
# ---------------------------------------------------------------------------------

# Auto-resolve threshold (Config UI writes it; the agent reads it after each proposal).
# Evidence-completeness score >= threshold -> unattended approve path; "off" disables.
#
# ⚠️ The score is `satisfied / prescribed required steps` for the classified skill — a STEP FUNCTION,
# not a continuum, so this threshold does not behave like a percentage dial. The shipped skills
# prescribe 4 (ledger-status-resolution), 5 (document-cross-reference) and 6 (record-match-review)
# required steps, whose highest PARTIAL scores are 0.75, 0.8 and 0.833. All three sit below 0.85, so
# this default means exactly one thing: EVERY prescribed step obtained data. Deliberately conservative.
#
# Before changing it, work out the reachable values for the skills you actually run. The gaps are wide
# and uneven: 0.8 still means 6-of-6 for record-match-review but drops document-cross-reference to
# 4-of-5, and 0.75 additionally drops ledger-status-resolution to 3-of-4. A skill whose step count
# changes silently re-tunes this gate.
# Keep this in step with the recon-agent module's `confidence_threshold`, which templates the Cedar
# gate.
resource "aws_ssm_parameter" "auto_resolve_threshold" {
  name  = "/${var.name_prefix}/auto-resolve-threshold"
  type  = "String"
  value = "0.85"

  lifecycle {
    ignore_changes = [value]
  }
}

# Decision-comment requirement for approve/disapprove: "required" | "optional" |
# "disapprove-only" (default — comment mandatory only when disapproving). Config UI writes it.
resource "aws_ssm_parameter" "comment_requirement" {
  name  = "/${var.name_prefix}/comment-requirement"
  type  = "String"
  value = "disapprove-only"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "tier1_enabled" {
  name  = "/${var.name_prefix}/tier1-enabled"
  type  = "String"
  value = "true"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "harness_config_version" {
  name  = "/${var.name_prefix}/harness-config-version"
  type  = "String"
  value = "none" # "none" = no active version (worker treats non-"v..." as absent → defaults).

  lifecycle {
    ignore_changes = [value] # Managed via the Config UI (deploy/rollback), never by TF.
  }
}

resource "aws_ssm_parameter" "agent_backend" {
  name  = "/${var.name_prefix}/agent-backend"
  type  = "String"
  value = "runtime" # runtime | harness — the agent-worker reads this at invocation time.

  lifecycle {
    ignore_changes = [value] # Switched at runtime from the Config tab, never by TF.
  }
}

# Which Bedrock model BOTH Tier-2 backends invoke. Selected in the Config tab alongside the backend
# itself, so comparing two models over one queue is a click rather than a merge and an apply.
#
# The seed matches the default the two backend env vars carry (recon-agent `model_id`, tier1
# `harness_model_id`), so a fresh deploy and an untouched parameter agree. The allowlist of
# selectable ids lives in backend/recon_core/model_select.py rather than here, because it is
# enforced on read by the code that invokes the model.
resource "aws_ssm_parameter" "agent_model_id" {
  name  = "/${var.name_prefix}/agent-model-id"
  type  = "String"
  value = var.agent_model_id

  lifecycle {
    ignore_changes = [value] # Selected at runtime from the Config tab, never by TF.
  }
}

# ---------------------------------------------------------------------------------
# S3 — raw source docs + assets (skills-catalog.json, KB seed, built SPA)
# ---------------------------------------------------------------------------------

resource "aws_s3_bucket" "raw" {
  bucket        = "${var.name_prefix}-raw"
  force_destroy = true
}

resource "aws_s3_bucket" "assets" {
  bucket        = "${var.name_prefix}-assets"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "raw" {
  bucket = aws_s3_bucket.raw.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "raw" {
  bucket                  = aws_s3_bucket.raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
