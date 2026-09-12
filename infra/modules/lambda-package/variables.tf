variable "backend_dir" {
  description = "Path to the backend/ source directory to package (absolute, or relative to the directory terraform runs in)."
  type        = string
}

variable "name" {
  description = "Base name for the output zip AND for this instance's staging directory (.build/<name>/staging), e.g. \"backend\". One staging directory per module instance: two instances in one checkout must use different names or they stage over each other."
  type        = string
  default     = "backend"
}

variable "runtime_dependencies" {
  description = "Third-party pip deps to vendor into the zip. boto3/botocore are provided by the Lambda runtime and must NOT be listed here."
  type        = list(string)
  # Empty by default, DELIBERATELY: which wheels a zip needs is a property of the Lambdas the ROOT
  # deploys, not of this module, so the root spells its own list out (see
  # infra/environments/recon/main.tf). A default that listed the recon dependencies would silently
  # bloat any leaner instance's zip; one that listed nothing while a root relied on it would ship a
  # zip whose imports fail at cold start. With an empty list stage.sh never calls pip.
  #
  # One list for every Lambda a root deploys: a root builds ONE zip and every Lambda it deploys runs
  # from it, so the list is the union of what all of them import. Each module instance stages into
  # its own directory (local.staging_dir is keyed by var.name), so two instances in one checkout with
  # different lists cannot overwrite each other's staging tree -- two given the SAME name would.
  #
  # The recon root's list is DUPLICATED in .gitlab-ci.yml's pre-plan staging call, which passes it
  # as arguments to stage.sh. The two MUST agree: archive_file reads the staging directory at PLAN
  # time, so whatever CI staged is what ships, and terraform_data.stage's hash will already match
  # at apply time and not re-stage to correct it. They drifted once already — CI was missing
  # PyYAML — and nothing caught it because the zip only rebuilds when the sources change.
  #
  # Changing a root's list alters local.stage_hash, so the zip is rebuilt and every Lambda it feeds
  # gets a new source_code_hash on the next apply — in-place updates, no deletes.
  #
  # A dependency that is published as a source distribution only cannot be installed by the
  # platform-pinned pip in stage.sh (--platform forces --only-binary=:all:). stage.sh builds a
  # wheel for any LISTED requirement that lacks one, and it can only see requirements that are
  # listed, so a transitive sdist-only package has to be named here as well to be reachable.
  default = []
}

variable "lambda_platform" {
  description = "pip --platform tag matching the Lambda architecture (x86_64 -> manylinux2014_x86_64; arm64 -> manylinux2014_aarch64)."
  type        = string
  default     = "manylinux2014_x86_64"
}

variable "lambda_python_version" {
  description = "pip --python-version matching the Lambda runtime."
  type        = string
  default     = "3.12"
}
