####################################################################################
# Shared Lambda packaging for the Python backend.
#
# Every handler imports the shared package as `from backend.<pkg>...` (matching the recon-agent
# Docker image and the test suite). A Lambda zip must therefore contain a top-level `backend/`
# PACKAGE directory — not backend/'s contents at the archive root.
#
# archive_file archives a directory's *contents* at the zip root, so we first stage
# backend/ into <build>/<name>/staging/backend/ and archive the staging dir. The result is a zip
# whose root holds `backend/recon_core/...`, `backend/deal_pipeline/...`, etc., and handlers are
# addressed as `backend.<pkg>.<module>.<fn>`.
#
# One zip per module INSTANCE is built and shared by every Lambda it feeds (the recon root: intake,
# tier1, idp-hook, the API BFFs and the two deal-pipeline functions), so the runtime layout matches
# the imports in exactly one place.
####################################################################################

locals {
  build_root = "${path.module}/.build"

  # Keyed by var.name: one staging directory per module instance. path.module is the module SOURCE
  # directory, identical for every instance, so with a single shared directory two instances in one
  # checkout (a full dependency list and a tzdata-only one) staged over each other: the leaner run
  # left its tree, and the other instance's next plan zipped it with no terraform_data.stage replace
  # to warn of it (its hash keys on its own inputs, which had not changed) -- every Lambda's
  # source_code_hash moved exactly as it does for an ordinary source edit, and a zip without pydantic
  # shipped.
  staging_dir = "${local.build_root}/${var.name}/staging"

  # What stage.sh excludes (its rsync --exclude list), kept in lockstep with the script: a file
  # that is not staged must not be hashed either, or a rebuilt __pycache__ would repackage both
  # Lambdas for a zip whose contents did not change. Two lists because rsync matches a pattern
  # against EVERY component of a path: an exact name excludes that file or directory (and its
  # contents) at any depth; a suffix excludes any component ending in it (*.egg-info is a
  # directory, *.pyc and *.swp are files).
  #
  # The OS and tool droppings (.DS_Store, .mypy_cache, *.egg-info, .coverage, .hypothesis, *.swp)
  # are here because fileset(backend_dir, "**") sees everything on disk, gitignored or not. Without
  # them, opening backend/ in Finder moved stage_hash, redeployed every Lambda for a content change
  # nobody made, and shipped the file inside the zip.
  unstaged_names    = toset(["__pycache__", ".venv", ".build", ".ruff_cache", ".pytest_cache", ".mypy_cache", ".hypothesis", ".DS_Store", ".coverage"])
  unstaged_suffixes = [".pyc", ".egg-info", ".swp"]

  # Every file that will end up in the zip, relative to backend_dir. EVERY file, not just *.py:
  # the OMS schema lives in deal_pipeline/oms_fields.json and both Lambdas load it at import, so
  # a schema change that touches no Python file still has to redeploy. Hashing only *.py once let
  # such an edit apply as "No changes" and left the deployed validator on the old header list.
  staged_files = [
    for f in sort(fileset(var.backend_dir, "**")) : f
    if !anytrue([
      for component in split("/", f) :
      contains(local.unstaged_names, component) || anytrue([for s in local.unstaged_suffixes : endswith(component, s)])
    ])
  ]

  # Path AND content per file, so a rename with identical bytes (or moving a module between
  # packages) changes the hash too -- the zip layout changed even though no content did.
  src_hash = sha1(join("\n", [
    for f in local.staged_files : "${f}:${filesha1("${var.backend_dir}/${f}")}"
  ]))

  # Re-stage when source OR the vendored-dependency set OR the wheel target OR the staging directory
  # changes. var.name is in here because data.archive_file.lambda reads the staging directory at
  # PLAN time: a renamed instance would otherwise look current in state while the directory it now
  # points at had never been filled, and plan would fail with "could not archive missing directory".
  stage_hash = sha1("${local.src_hash}|${join(",", var.runtime_dependencies)}|${var.lambda_python_version}|${var.lambda_platform}|${var.name}")
}

# Stage backend/ into <build>/<name>/staging/backend/ (nested) and, when var.runtime_dependencies
# is non-empty, vendor those pip deps at the staging root (top-level importable). Runs only when
# local.stage_hash changes.
#
# boto3/botocore are provided by the Lambda runtime, so they are NOT vendored. Any dependency
# that is listed is installed as a manylinux wheel matching the Lambda architecture
# (var.lambda_platform) — NOT the build host — via pip --platform, because a compiled extension
# built for a macOS or CI-runner host would not load on Lambda.
#
# The body lives in stage.sh rather than inline here so a developer can re-run exactly the same
# staging by hand: data.archive_file.lambda below reads the staging directory at PLAN time, so a
# checkout whose state says staging is current but whose gitignored .build/ is gone (git clean
# -fdx, a fresh clone with copied state) cannot plan until it is rebuilt. See stage.sh's header.
resource "terraform_data" "stage" {
  triggers_replace = local.stage_hash

  provisioner "local-exec" {
    command = join(" ", concat(
      [
        "'${path.module}/stage.sh'",
        "'${local.staging_dir}'",
        "'${var.backend_dir}'",
        "'${var.lambda_platform}'",
        "'${var.lambda_python_version}'",
      ],
      [for d in var.runtime_dependencies : "'${d}'"],
    ))
  }
}

# Archive the staging dir; its contents (the nested backend/ package) become the zip root.
# depends_on defers the read to apply time whenever terraform_data.stage has a pending change,
# which is what lets the zip and both functions' source_code_hash update in the same apply.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = local.staging_dir
  output_path = "${local.build_root}/${var.name}.zip"

  depends_on = [terraform_data.stage]
}
