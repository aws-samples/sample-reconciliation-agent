####################################################################################
# Workflow types: what an operator may upload, and where each kind of upload goes.
#
# A row here answers one question about a document -- is it EXTRACTED into a
# structured notice, or INGESTED into the knowledge base as guidance? Those are two
# different destinations with two different downstream shapes, and the answer is a
# stored value rather than something inferred from which other fields happen to be
# filled in. Inference is what makes an accidental blank dangerous: an upload with no
# extraction version pinned does not fail, it silently gets whatever configuration
# happens to be active at that moment, which is a wrong extraction with no error
# anywhere to explain it.
#
# The table is CONFIGURATION an operator edits from the Config tab while the system is
# running -- same posture as infra/modules/contact-store/, and modelled on it. No
# stream, deliberately: a stream is what makes a table case-creating, and naming a
# document category must never open a reconciliation case.
####################################################################################

resource "aws_dynamodb_table" "workflow_types" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-workflow-types"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "workflow_type_id"

  attribute {
    name = "workflow_type_id"
    type = "S"
  }

  # No GSI. Every reader wants the whole list (the Config panel, and later the upload picker), so a
  # Scan is the access pattern rather than a fallback -- this is tens of rows, entered by hand, not
  # thousands. `active` could not be indexed anyway: DynamoDB will not key on a BOOLEAN.
  #
  # The remaining attributes -- display_name, route, idp_config_version, kb_doc_type, description,
  # extra_metadata, active, and the four audit fields -- are the ITEM shape, not the table schema.
  # DynamoDB declares only the key, so the only thing standing between the table and an incoherent
  # row is the validator in chatbot-app/frontend/src/lib/workflowTypes.ts. If you add a field, add
  # it there too; nothing here will notice.
  point_in_time_recovery {
    enabled = true
  }
}

# ---------------------------------------------------------------------------------
# Create-only seeding. `ignore_changes = [item]` is the whole point: without it every
# apply would revert an operator's edits, including a deactivation, which turns the
# Config tab into a form whose answers expire at the next deploy.
#
# Only the knowledge-base type is seeded unconditionally, because it is the one whose
# fields are fully knowable from here -- a knowledge-base route pins no extraction
# version, so there is nothing to guess. The extraction seed needs a real IDP
# configuration version name, which lives in the other deployment and which this
# module has no way to look up (the API that lists them refuses a machine
# caller). Seeding it with a placeholder would produce exactly the failure the route
# field exists to prevent, so it is seeded only when an operator supplies the name.
# ---------------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "kb_guidance_seed" {
  table_name = aws_dynamodb_table.workflow_types.name
  hash_key   = aws_dynamodb_table.workflow_types.hash_key

  item = jsonencode({
    workflow_type_id = { S = "counterparty-guidance" }
    display_name     = { S = "Counterparty guidance / correspondence" }
    route            = { S = "knowledge-base" }
    # Empty on purpose and enforced both ways by the validator: a knowledge-base document is not
    # extracted, so pinning an extraction version to it would describe a destination it never reaches.
    idp_config_version = { S = "" }
    kb_doc_type        = { S = "email" }
    description        = { S = "Emails and letters that explain how a counterparty behaves. Retrieved as guidance during an investigation; never turned into a notice row." }
    active             = { BOOL = true }
    created_by         = { S = "terraform-seed" }
    created_at         = { S = "seed" }
    updated_by         = { S = "terraform-seed" }
    updated_at         = { S = "seed" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table_item" "extraction_seed" {
  count = var.seed_extraction_config_version == "" ? 0 : 1

  table_name = aws_dynamodb_table.workflow_types.name
  hash_key   = aws_dynamodb_table.workflow_types.hash_key

  item = jsonencode({
    workflow_type_id   = { S = "unapplied-cash-notice" }
    display_name       = { S = "Unapplied cash notice" }
    route              = { S = "extraction" }
    idp_config_version = { S = var.seed_extraction_config_version }
    # Empty because this route is not a knowledge-base route. The facet only means something to the
    # knowledge base, and stamping one here would suggest the document lands in two places.
    kb_doc_type = { S = "" }
    description = { S = "A counterparty's notice of a payment that has not been applied to an open item. Extracted into a structured notice row." }
    active      = { BOOL = true }
    created_by  = { S = "terraform-seed" }
    created_at  = { S = "seed" }
    updated_by  = { S = "terraform-seed" }
    updated_at  = { S = "seed" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
