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
#
# The body lives in stage.sh rather than inline here because CI has to run the same staging
# before `terraform plan`: data.archive_file.lambda below reads .build/staging at PLAN time,
# while this provisioner only fills it at APPLY time, so a checkout that has never applied
# cannot plan. See the header comment in stage.sh.
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
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = local.staging_dir
  output_path = "${local.build_root}/${var.name}.zip"

  depends_on = [terraform_data.stage]
}
