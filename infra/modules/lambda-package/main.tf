####################################################################################
# Shared Lambda packaging for the Python backend.
#
# All handler code imports the shared package as `from backend.<pkg>...` (matching the
# recon-agent Docker image and the test suite). A Lambda zip must therefore contain a
# top-level `backend/` PACKAGE directory — not backend/'s contents at the archive root.
#
# archive_file archives a directory's *contents* at the zip root, so we first stage
# backend/ into <build>/backend/ and archive the staging dir. The result is a zip whose
# root holds `backend/recon_core/...`, `backend/idp_hook/...`, etc., and handlers are
# addressed as `backend.<pkg>.<module>.<fn>`.
#
# One package is built and shared by every Lambda module (intake, tier1, idp-hook, api),
# so the runtime layout matches the imports in exactly one place.
####################################################################################

# Re-stage whenever any tracked backend source changes (hash of all .py files).
locals {
  build_root  = "${path.module}/.build"
  staging_dir = "${path.module}/.build/staging"
  src_hash = sha1(join("", [
    for f in sort(fileset(var.backend_dir, "**/*.py")) :
    filesha1("${var.backend_dir}/${f}")
  ]))
  # Re-stage when source OR the vendored-dependency set changes.
  stage_hash = sha1("${local.src_hash}|${join(",", var.runtime_dependencies)}|${var.lambda_python_version}|${var.lambda_platform}")
}

# Stage backend/ into <build>/staging/backend/ (nested) and vendor the runtime pip deps at the
# staging root (top-level importable, e.g. pydantic). Runs when source or deps change.
#
# boto3/botocore are provided by the Lambda runtime, so they are NOT vendored. pydantic ships a
# compiled extension (pydantic_core), so deps are installed as manylinux wheels matching the
# Lambda architecture (var.lambda_platform) — NOT the build host — via pip --platform.
resource "terraform_data" "stage" {
  triggers_replace = local.stage_hash

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      rm -rf "${local.staging_dir}"
      mkdir -p "${local.staging_dir}/backend"
      rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '*.pyc' \
        --exclude '.venv' \
        --exclude '.build' \
        --exclude '.ruff_cache' \
        --exclude '.pytest_cache' \
        "${var.backend_dir}/" "${local.staging_dir}/backend/"
      python3 -m pip install \
        --platform "${var.lambda_platform}" \
        --python-version "${var.lambda_python_version}" \
        --implementation cp \
        --only-binary=:all: \
        --target "${local.staging_dir}" \
        ${join(" ", [for d in var.runtime_dependencies : "'${d}'"])}
      find "${local.staging_dir}" -type d -name '__pycache__' -prune -exec rm -rf {} +
      find "${local.staging_dir}" -type d -name '*.dist-info' -prune -exec rm -rf {} +
      # Excluding __pycache__ leaves behind any source directory whose only remaining content WAS
      # a cache — e.g. a stale untracked backend/<deleted-module>/__pycache__ arrives as an empty
      # directory and archive_file records it, so the zip differs between two checkouts of the same
      # commit. Any empty directory here is dead weight regardless: a Python package carries an
      # __init__.py, and a vendored wheel always ships files. -depth so parents empty out first.
      find "${local.staging_dir}" -depth -type d -empty -delete
    EOT
  }
}

# Archive the staging dir; its contents (the nested backend/ package) become the zip root.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = local.staging_dir
  output_path = "${local.build_root}/${var.name}.zip"

  depends_on = [terraform_data.stage]
}
