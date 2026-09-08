####################################################################################
# Upload submissions: what recon sent, where it sent it, and what it asked for.
#
# This is the only record of the recon side of an upload. Neither destination keeps
# one:
#
#   - The document pipeline's listDocuments does not surface custom S3 object
#     metadata, so it can report which configuration version it USED but not which
#     one recon asked for. Those two disagreeing is precisely the failure worth
#     catching -- an unpinned object does not error, the pipeline silently resolves
#     whichever version is active -- and without a row here there is nothing to
#     compare its answer against.
#   - The knowledge base reports nothing readable at all. A KB-routed document
#     appears in no listing the console can query, so without this table the tab
#     cannot show that the upload happened, let alone whether it has been ingested.
#
# A row is written before either put and updated after, so a crash between the two
# leaves a visible PENDING rather than silence.
#
# No stream, for the same reason as workflow-types: a stream is what makes a table
# case-creating, and recording an upload must never open a reconciliation case.
####################################################################################

resource "aws_dynamodb_table" "uploads" {
  #checkov:skip=CKV_AWS_119:Demo uses the AWS-owned DynamoDB encryption key (encrypted at rest by default); a customer-managed CMK adds key-management cost/rotation overhead not warranted for synthetic demo data.
  name         = "${var.name_prefix}-idp-uploads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "submission_id"

  attribute {
    name = "submission_id"
    type = "S"
  }

  attribute {
    name = "uploaded_at"
    type = "S"
  }

  # The tab's only query is "the most recent submissions", and a Scan cannot answer it in order --
  # DynamoDB returns Scan results in no defined order, so a Scan-then-sort is correct only while the
  # whole table fits in one page and silently wrong afterwards. A single-partition GSI sorted by
  # timestamp is the standard shape for that, and the write rate here (a human uploading files) is
  # nowhere near the per-partition limit that makes it a bad idea elsewhere.
  global_secondary_index {
    name            = "by_recency"
    hash_key        = "gsi_bucket"
    range_key       = "uploaded_at"
    projection_type = "ALL"
  }

  attribute {
    name = "gsi_bucket"
    type = "S"
  }

  # The remaining attributes -- workflow_type, route, config_version, uploaded_by,
  # status_updated_at, and the `files` list itself -- are the ITEM shape, not the table
  # schema. DynamoDB declares only keys, so the writer in
  # chatbot-app/frontend/src/lib/uploadRecord.ts is the only thing that keeps a row coherent.
  point_in_time_recovery {
    enabled = true
  }
}
