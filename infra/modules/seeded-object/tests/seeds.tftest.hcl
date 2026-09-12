# Run from this module's directory: `terraform init && terraform test`.
#
# MOCKED AWS provider: nothing is created and no credentials are read (the mock still needs the
# provider binary for its schema, hence the init). The fixtures under tests/fixtures/ are read
# relative to this directory, which is where `terraform test` runs; test-file variables cannot use
# path.*, which is why they are not addressed through path.module.
#
# The structural runs are plan-only. The last four runs apply against the MOCK -- no bucket exists,
# the mock records the planned values as state -- so that a second plan can show the one property
# this module exists for: a create-only seed whose repo file has changed plans NO change, while a
# tracking seed plans the re-upload. That is `ignore_changes` doing its work, which a plan from
# empty state cannot show.

mock_provider "aws" {}

variables {
  bucket       = "seed-test-bucket"
  key          = "prompts/test-system.md"
  content_type = "text/markdown"
}

run "create_only_instantiates_the_ignoring_block_and_nothing_else" {
  command = plan

  variables {
    create_only = true
    source_path = "tests/fixtures/v1.md"
  }

  assert {
    condition     = length(aws_s3_object.create_only) == 1 && length(aws_s3_object.tracking) == 0
    error_message = "create_only = true must plan exactly one aws_s3_object.create_only and no aws_s3_object.tracking"
  }

  # Every argument a seed moved in here already has, unchanged: a different value on any of them
  # plans a re-upload of an object the application may have edited.
  assert {
    condition = (
      aws_s3_object.create_only[0].bucket == "seed-test-bucket"
      && aws_s3_object.create_only[0].key == "prompts/test-system.md"
      && aws_s3_object.create_only[0].source == "tests/fixtures/v1.md"
      && aws_s3_object.create_only[0].content == null
      && aws_s3_object.create_only[0].etag == filemd5("tests/fixtures/v1.md")
      && aws_s3_object.create_only[0].content_type == "text/markdown"
    )
    error_message = "bucket, key, source, etag (= filemd5 of the source) and content_type must reach the object exactly as given, with content unset"
  }

  assert {
    condition     = output.key == "prompts/test-system.md" && output.bucket == "seed-test-bucket" && output.etag == filemd5("tests/fixtures/v1.md") && output.content_type == "text/markdown"
    error_message = "the outputs must describe the one instantiated object"
  }
}

run "tracking_instantiates_the_following_block_and_nothing_else" {
  command = plan

  variables {
    create_only = false
    source_path = "tests/fixtures/v1.md"
  }

  assert {
    condition     = length(aws_s3_object.tracking) == 1 && length(aws_s3_object.create_only) == 0
    error_message = "create_only = false must plan exactly one aws_s3_object.tracking and no aws_s3_object.create_only"
  }

  assert {
    condition = (
      aws_s3_object.tracking[0].key == "prompts/test-system.md"
      && aws_s3_object.tracking[0].source == "tests/fixtures/v1.md"
      && aws_s3_object.tracking[0].etag == filemd5("tests/fixtures/v1.md")
      && aws_s3_object.tracking[0].content_type == "text/markdown"
      && output.etag == filemd5("tests/fixtures/v1.md")
    )
    error_message = "a tracking seed carries the same arguments as a create-only one; only the lifecycle differs"
  }
}

run "inline_content_is_fingerprinted_as_it_will_be_stored" {
  command = plan

  variables {
    create_only = false
    content     = "Rendered seed content, with a trailing newline.\n"
  }

  assert {
    condition = (
      aws_s3_object.tracking[0].content == "Rendered seed content, with a trailing newline.\n"
      && aws_s3_object.tracking[0].source == null
      && aws_s3_object.tracking[0].etag == md5("Rendered seed content, with a trailing newline.\n")
    )
    error_message = "with content set, source must be unset and the etag must be the MD5 of the content string"
  }
}

run "both_source_path_and_content_fail_at_plan" {
  command = plan

  variables {
    create_only = true
    source_path = "tests/fixtures/v1.md"
    content     = "also inline"
  }

  expect_failures = [var.source_path]
}

run "neither_source_path_nor_content_fails_at_plan" {
  command = plan

  variables {
    create_only = true
  }

  expect_failures = [var.source_path]
}

# --- The property: create-only ignores the repo after the first write; tracking follows it. -------

run "seed_a_create_only_object_from_v1" {
  command = apply

  variables {
    create_only = true
    source_path = "tests/fixtures/v1.md"
  }

  assert {
    condition     = aws_s3_object.create_only[0].etag == filemd5("tests/fixtures/v1.md")
    error_message = "the first write carries the v1 fingerprint"
  }
}

run "a_create_only_seed_plans_no_change_when_the_repo_file_changes" {
  command = plan

  variables {
    create_only = true
    source_path = "tests/fixtures/v2.md"
  }

  # The planned values are the STATE's values: etag and source stay at v1 although the
  # configuration now points at v2. Without the lifecycle block this run would plan a re-upload
  # and the etag would read as v2's.
  assert {
    condition     = aws_s3_object.create_only[0].etag == filemd5("tests/fixtures/v1.md") && aws_s3_object.create_only[0].source == "tests/fixtures/v1.md"
    error_message = "a create-only seed must keep the live object's etag and source when the repo file changes: ignore_changes is not covering etag/source"
  }

  # And the fixtures do differ, or the assertion above proves nothing: the kept etag is not v2's.
  assert {
    condition     = aws_s3_object.create_only[0].etag != filemd5("tests/fixtures/v2.md")
    error_message = "the two fixtures must differ, or the run above proves nothing"
  }
}

run "a_create_only_seed_plans_no_change_when_the_content_type_changes" {
  command = plan

  variables {
    create_only  = true
    source_path  = "tests/fixtures/v1.md"
    content_type = "text/markdown; charset=utf-8"
  }

  # The case the wide list exists for: an application write that only adds a charset. With
  # [etag, source] alone this plans a full re-upload from the repo file.
  assert {
    condition     = aws_s3_object.create_only[0].content_type == "text/markdown"
    error_message = "a create-only seed must keep the live content_type: ignore_changes is not covering content_type"
  }
}

run "seed_a_tracking_object_from_v1" {
  command = apply

  variables {
    create_only = false
    source_path = "tests/fixtures/v1.md"
  }

  assert {
    condition     = aws_s3_object.tracking[0].etag == filemd5("tests/fixtures/v1.md")
    error_message = "the first write carries the v1 fingerprint"
  }
}

run "a_tracking_seed_plans_the_re_upload_when_the_repo_file_changes" {
  command = plan

  variables {
    create_only = false
    source_path = "tests/fixtures/v2.md"
  }

  assert {
    condition     = aws_s3_object.tracking[0].etag == filemd5("tests/fixtures/v2.md") && aws_s3_object.tracking[0].source == "tests/fixtures/v2.md"
    error_message = "a tracking seed must follow the repo file: etag and source must read as v2's"
  }
}
