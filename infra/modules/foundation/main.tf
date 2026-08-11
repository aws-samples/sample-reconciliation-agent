####################################################################################
# Foundation module: Cognito (OAuth), S3 buckets, and recon-flow DynamoDB tables.
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

  # Stream feeds the Tier-1 consumer (Task 18).
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
# Runtime config — deterministic Tier-1 on/off toggle (Config UI writes it; Tier-1
# Lambda reads it per batch). Created with an initial "true" default; the Config UI
# overwrites the value, so ignore value drift on subsequent applies.
# ---------------------------------------------------------------------------------

# Auto-resolve threshold (Config UI writes it; the agent reads it after each proposal).
# Composite confidence >= threshold -> unattended approve path; "off" disables.
#
# 0.85, NOT 0.95. The composite is a weighted sum whose verbalized term (0.20) is supplied by a
# model that habitually states 0.5-0.6, so 0.95 is arithmetically unreachable: even a perfect
# classification signal + perfect grounding caps the composite at 0.91 (runtime) / 0.89 (harness)
# at the modal verbalized 0.55. Across 10 observed cases the best composite was 0.775 and NONE
# auto-executed. 0.85 still demands a strong result on all three signals simultaneously
# (roughly classification >=0.93, grounding >=0.9, verbalized >=0.7 together) — it is the
# conservative end of the reachable band, chosen because no target auto-execute rate was
# specified. Keep this in step with the recon-agent module's `confidence_threshold`, which
# templates the Cedar gate. See the harness signal + tool-parity design
# record (D5/D6) for the achievable-range table.
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

# ---------------------------------------------------------------------------------
# Cognito — OAuth 2.0 authorization-code + PKCE for the SPA login flow
# ---------------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.hosted_ui_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name_prefix}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  # Public SPA client using PKCE — no client secret.
  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  supported_identity_providers         = ["COGNITO"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]

  # The real CloudFront callback/logout URLs are patched in out-of-band by
  # null_resource.cognito_callbacks (environments/recon/main.tf) once the frontend
  # distribution exists — that patch is never fed back into this resource's declared state,
  # so every subsequent plan would otherwise want to revert it to the placeholder default,
  # breaking login. This lifecycle block is the fix, not just documentation.
  lifecycle {
    ignore_changes = [callback_urls, logout_urls]
  }
}
