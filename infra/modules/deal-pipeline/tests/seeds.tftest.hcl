# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only under a MOCKED AWS provider: nothing is created and no credentials are read. The seeds
# are read from the real checkout (content_root defaults to three levels above the module), so these
# runs also prove the committed corpus is what the module will upload.
#
# What is under test is the contract between the S3 layout and the two readers of the sample corpus:
# the seed keys must sit under the prefix the module OUTPUTS (the frontend's PIPELINE_SAMPLES_PREFIX
# is that output), and the object name under the prefix must be the corpus id the BFF's simulate
# dialog sends back -- so `<prefix><id>.json` is a fetchable key without any lookup table.

mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/deal-pipeline-test-mock"
    }
  }
  override_data {
    target = data.aws_iam_policy_document.lambda_assume
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }
  override_data {
    target = data.aws_region.current
    values = {
      region = "us-east-1"
    }
  }
}

variables {
  name_prefix        = "deal-pipeline-test"
  lambda_zip         = "never-read-under-a-mock-provider.zip"
  lambda_source_hash = "dGVzdA=="
}

run "sample_corpus_is_seeded_under_the_output_prefix" {
  command = plan

  assert {
    condition     = length(aws_s3_object.sample_email_seed) > 0
    error_message = "the committed corpus under data/deal-emails must seed at least one object, or a deployed inbox has nothing to simulate"
  }

  assert {
    condition = alltrue([
      for o in aws_s3_object.sample_email_seed : startswith(o.key, output.samples_prefix)
    ])
    error_message = "every sample seed key must sit under the samples_prefix output, which is what the frontend is told to list"
  }

  # The BFF accepts a corpus id only when it matches ^[a-z0-9][a-z0-9-]*$ and then fetches
  # `<prefix><id>.json`. A file whose name breaks that pattern would seed fine and be unreachable.
  assert {
    condition = alltrue([
      for o in aws_s3_object.sample_email_seed :
      can(regex("^[a-z0-9][a-z0-9-]*\\.json$", trimprefix(o.key, output.samples_prefix)))
    ])
    error_message = "every sample file name must be <corpus-id>.json with a lowercase-alphanumeric-and-hyphen id, or the BFF refuses to fetch it"
  }

  # A JSON body served as binary/octet-stream still parses, but the corpus is fetched by a browser-
  # facing route and the content type is the one signal S3 gives a reader about what it is holding.
  assert {
    condition     = alltrue([for o in aws_s3_object.sample_email_seed : o.content_type == "application/json"])
    error_message = "sample seeds must be uploaded as application/json"
  }
}

run "sample_seeds_track_the_repository" {
  command = plan

  # Unlike skills and the parser prompt, the corpus has no UI editor, so a repo edit must reach S3
  # on the next apply. That is only true when etag follows the file; a resource that carried
  # ignore_changes on etag would silently pin the first upload forever.
  assert {
    condition     = alltrue([for o in aws_s3_object.sample_email_seed : o.etag == filemd5(o.source)])
    error_message = "each sample seed's etag must be the md5 of the committed file, so an edited sample re-uploads on the next apply"
  }
}
