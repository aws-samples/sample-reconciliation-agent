# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only on purpose. An apply would run terraform_data.stage's provisioner, and stage.sh
# rm -rf's the module's ONE shared .build/staging directory -- the directory the real root's next
# plan zips. A plan never runs the provisioner, and the two outputs under test (staged_files,
# stage_hash) depend only on the source tree, so they are known at plan time.
#
# backend_dir is relative to the directory terraform runs in (this module's), which is why the
# fixtures live under tests/fixtures/ rather than being addressed through path.module: test-file
# variables blocks cannot use path.*.

variables {
  runtime_dependencies = []
}

# tests/fixtures/baseline: two real files plus one of everything stage.sh excludes
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
