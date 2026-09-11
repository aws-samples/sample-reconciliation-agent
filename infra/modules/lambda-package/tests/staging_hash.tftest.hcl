# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only on purpose. An apply would run terraform_data.stage's provisioner, and stage.sh
# rm -rf's the staging directory it is pointed at -- for the default name that is the recon root's
# .build/backend/staging, the directory that root's next plan zips. A plan never runs the
# provisioner, and the outputs under test (staged_files, stage_hash, staging_dir) depend only on the
# source tree and the inputs, so they are known at plan time.
#
# backend_dir is relative to the directory terraform runs in (this module's), which is why the
# fixtures live under tests/fixtures/ rather than being addressed through path.module: test-file
# variables blocks cannot use path.*.

variables {
  runtime_dependencies = []
}

# tests/fixtures/baseline: two real files plus one of everything the ORIGINAL exclude list named
# (__pycache__/*.pyc, a stray *.pyc, .venv/, .build/, .ruff_cache/, .pytest_cache/).
run "baseline" {
  command = plan

  variables {
    backend_dir = "tests/fixtures/baseline"
  }

  assert {
    condition     = toset(output.staged_files) == toset(["pkg/handler.py", "pkg/schema.json"])
    error_message = "staged_files must be every file stage.sh copies (the JSON schema included) and nothing it excludes; got ${jsonencode(output.staged_files)}"
  }

  # The default name is the recon root's; its staging directory is the one .gitlab-ci.yml fills
  # before plan, so the two must agree on the path.
  assert {
    condition     = endswith(output.staging_dir, "/.build/backend/staging")
    error_message = "the default instance must stage into .build/backend/staging (the path .gitlab-ci.yml's pre-plan stage.sh call writes); got ${output.staging_dir}"
  }
}

# tests/fixtures/clean: the same two real files, none of the junk.
run "excluded_files_do_not_change_the_hash" {
  command = plan

  variables {
    backend_dir = "tests/fixtures/clean"
  }

  assert {
    condition     = output.stage_hash == run.baseline.stage_hash
    error_message = "files stage.sh excludes must not feed stage_hash, or a rebuilt bytecode cache would repackage both Lambdas for an identical zip"
  }
}

# tests/fixtures/stray-files: the clean pair plus what Finder, mypy, `pip install -e`, coverage.py,
# hypothesis and an editor leave behind (.DS_Store, .mypy_cache/, *.egg-info/, .coverage,
# .hypothesis/, *.swp). All gitignored or untracked, so invisible to git status, yet on disk where
# fileset("**") sees them. Before these were excluded, one Finder visit to backend/ replaced
# terraform_data.stage and redeployed every Lambda with the .DS_Store inside the zip.
run "os_and_tool_droppings_are_neither_staged_nor_hashed" {
  command = plan

  variables {
    backend_dir = "tests/fixtures/stray-files"
  }

  assert {
    condition     = toset(output.staged_files) == toset(["pkg/handler.py", "pkg/schema.json"])
    error_message = "OS and tool droppings must not be staged: .DS_Store, .mypy_cache, *.egg-info, .coverage, .hypothesis and *.swp are excluded by stage.sh, so hashing them would repackage for a zip that did not change; got ${jsonencode(output.staged_files)}"
  }

  assert {
    condition     = output.stage_hash == run.baseline.stage_hash
    error_message = "a stray .DS_Store (or any other excluded dropping) must not move stage_hash"
  }
}

# tests/fixtures/json-changed: identical handler.py, one more field in schema.json.
run "non_python_change_restages" {
  command = plan

  variables {
    backend_dir = "tests/fixtures/json-changed"
  }

  assert {
    condition     = output.stage_hash != run.baseline.stage_hash
    error_message = "editing a non-Python file that ships in the zip (oms_fields.json) must change stage_hash; hashing only *.py let such an edit apply as 'No changes' and left the deployed validator on the old header list"
  }
}

# tests/fixtures/renamed: byte-identical content, schema.json renamed to schema-v2.json.
run "rename_restages" {
  command = plan

  variables {
    backend_dir = "tests/fixtures/renamed"
  }

  assert {
    condition     = output.stage_hash != run.baseline.stage_hash
    error_message = "renaming a file with unchanged content must change stage_hash: the zip's layout changed, and imports resolve by path"
  }
}

# Same sources, a second instance name (the standalone deal-pipeline root's). Two roots that share
# one checkout used to stage into ONE directory under the module path; whichever ran last left its
# dependency set there, and the other root's next plan zipped it with nothing in the plan to say so.
run "staging_directory_is_keyed_by_name" {
  command = plan

  variables {
    backend_dir = "tests/fixtures/clean"
    name        = "deal-pipeline-backend"
  }

  assert {
    condition     = output.staging_dir != run.excluded_files_do_not_change_the_hash.staging_dir && endswith(output.staging_dir, "/.build/deal-pipeline-backend/staging")
    error_message = "two instances with different names must stage into different directories, or the second root's staging run overwrites the first root's zip contents; got ${output.staging_dir}"
  }

  # The name is part of what terraform_data.stage keys on: archive_file reads the staging directory
  # at plan time, so a renamed instance has to re-stage into its new directory or the plan fails with
  # "could not archive missing directory" while state says staging is current.
  assert {
    condition     = output.stage_hash != run.excluded_files_do_not_change_the_hash.stage_hash
    error_message = "changing var.name moves the staging directory, so it must change stage_hash and re-stage"
  }
}
